"""
Town Hall Notes Classifier
Trains a text classifier to sort notes into their proper wiki page.

CSV format expected (--data flag):
    text,label
    "No phones during town hall",shared-roes
    "Silent lunch timer runs 30 min",ms-strikes
    ...

Labels should match wiki page names:
    es-roes | es-strikes | ms-rules | ms-strikes | positions | shared-roes

Usage:
    python train_classifier.py --data notes.csv
    python train_classifier.py --data notes.csv --model-type semantic   # uses sentence-transformers
    python train_classifier.py --data notes.csv --predict "learners keep phones away"
"""

import argparse
import csv
import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")

# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

VALID_LABELS = {
    # Original broad labels (kept for backwards compatibility)
    "es-roes",
    "es-strikes",
    "ms-rules",
    "ms-strikes",
    "positions",
    "shared-roes",
    # ES Rules of Engagement
    "es-roes-promise",       # Hero's Promise recitation
    "es-roes-conduct",       # Classroom behaviour / Socratic rules
    # ES Strike System
    "es-strike-regular",     # Blue mark / friendly reminder / 5-min timer
    "es-strike-guardrail",   # Red mark / immediate / 10-min timer
    "es-strike-refusal",     # Refusal-to-reset tracking & penalties
    # MS Strike System
    "ms-strike-lgg",         # Low Grade Guardrail / bottle lid
    "ms-strike-apology",     # Apology letter process & sign-off
    "ms-strike-silent-lunch",# 30-minute silent lunch consequence
    # MS Academics & Schedule
    "ms-rules-academics",    # Quest goals, core skills, grades
    "ms-rules-schedule",     # Morning launch, closing circle, daily flow
    # Leadership Positions
    "positions-eligibility",  # Mark/strike thresholds for holding roles
    "positions-townhall",     # Town Hall Leader, Secretary, Assistant roles
    "positions-strike-staff", # Strike Champion & backup roles
    # Shared Rules of Engagement
    "shared-safety",          # Physical safety / non-negotiable guardrails
    "shared-phones",          # Phone / device rules
    "shared-kitchen",         # Kitchen / lunchroom rules
    # Tool pages
    "election",               # Election procedures, voting, runoffs
    "roster",                 # Member registration, studio assignment
}

MODEL_PATH = "townhall_model.joblib"
META_PATH  = "townhall_model_meta.json"


def load_csv(path: str):
    texts, labels = [], []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for i, row in enumerate(reader, 1):
            text  = row.get("text",  "").strip()
            label = row.get("label", "").strip().lower()
            if not text or not label:
                print(f"  [skip] row {i}: empty text or label")
                continue
            if label not in VALID_LABELS:
                print(f"  [warn] row {i}: unknown label '{label}' — keeping anyway")
            texts.append(text)
            labels.append(label)
    return texts, labels


# --------------------------------------------------------------------------- #
# TF-IDF + Logistic Regression  (default, no GPU needed)
# --------------------------------------------------------------------------- #

def train_tfidf(texts, labels, test_size=0.2, random_state=42):
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import Pipeline
    from sklearn.model_selection import train_test_split, cross_val_score
    from sklearn.metrics import classification_report, confusion_matrix
    import joblib

    print(f"\n[tfidf] {len(texts)} samples, {len(set(labels))} classes")

    # Cross-val first (uses all data, good for small datasets)
    pipeline = Pipeline([
        ("tfidf", TfidfVectorizer(
            ngram_range=(1, 2),   # unigrams + bigrams
            min_df=1,
            sublinear_tf=True,
        )),
        ("clf", LogisticRegression(
            max_iter=1000,
            class_weight="balanced",
            solver="lbfgs",
            multi_class="auto",
        )),
    ])

    if len(texts) >= 10:
        cv_scores = cross_val_score(pipeline, texts, labels, cv=min(5, len(texts)//2), scoring="accuracy")
        print(f"[tfidf] Cross-val accuracy: {cv_scores.mean():.2%} ± {cv_scores.std():.2%}")
    else:
        print(f"[tfidf] Too few samples for cross-val — training on all data")

    # Train/test split for a held-out report
    if len(texts) >= 6:
        X_train, X_test, y_train, y_test = train_test_split(
            texts, labels, test_size=test_size, random_state=random_state, stratify=labels
        )
        pipeline.fit(X_train, y_train)
        y_pred = pipeline.predict(X_test)
        print("\n[tfidf] Classification report (held-out test set):")
        print(classification_report(y_test, y_pred, zero_division=0))

        cm = confusion_matrix(y_test, y_pred, labels=sorted(set(labels)))
        classes = sorted(set(labels))
        print("[tfidf] Confusion matrix:")
        header = "          " + "  ".join(f"{c[:8]:>8}" for c in classes)
        print(header)
        for i, row in enumerate(cm):
            print(f"  {classes[i][:8]:>8}  " + "  ".join(f"{v:>8}" for v in row))
    else:
        print("[tfidf] Very small dataset — skipping train/test split, fitting on all data")

    # Final model trained on everything
    pipeline.fit(texts, labels)

    # Save
    import joblib
    joblib.dump(pipeline, MODEL_PATH)
    meta = {"type": "tfidf", "labels": sorted(set(labels))}
    with open(META_PATH, "w") as f:
        json.dump(meta, f, indent=2)

    print(f"\n[tfidf] Model saved → {MODEL_PATH}")
    return pipeline


# --------------------------------------------------------------------------- #
# Sentence-Transformers + Logistic Regression  (optional, better accuracy)
# --------------------------------------------------------------------------- #

def train_semantic(texts, labels, test_size=0.2, random_state=42):
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        print("[error] sentence-transformers not installed.")
        print("        Run: pip install sentence-transformers")
        sys.exit(1)

    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import train_test_split, cross_val_score
    from sklearn.metrics import classification_report
    import joblib

    print(f"\n[semantic] Loading sentence-transformer model…")
    encoder = SentenceTransformer("all-MiniLM-L6-v2")

    print(f"[semantic] Encoding {len(texts)} samples…")
    X = encoder.encode(texts, show_progress_bar=True, convert_to_numpy=True)

    clf = LogisticRegression(max_iter=1000, class_weight="balanced", solver="lbfgs")

    if len(texts) >= 10:
        cv_scores = cross_val_score(clf, X, labels, cv=min(5, len(texts)//2), scoring="accuracy")
        print(f"[semantic] Cross-val accuracy: {cv_scores.mean():.2%} ± {cv_scores.std():.2%}")

    if len(texts) >= 6:
        X_train, X_test, y_train, y_test = train_test_split(
            X, labels, test_size=test_size, random_state=random_state, stratify=labels
        )
        clf.fit(X_train, y_train)
        y_pred = clf.predict(X_test)
        print("\n[semantic] Classification report (held-out test set):")
        print(classification_report(y_test, y_pred, zero_division=0))
    else:
        print("[semantic] Very small dataset — fitting on all data")

    clf.fit(X, labels)

    # Save the embeddings model name + sklearn classifier together
    bundle = {"encoder_name": "all-MiniLM-L6-v2", "clf": clf}
    joblib.dump(bundle, MODEL_PATH)
    meta = {"type": "semantic", "labels": sorted(set(labels))}
    with open(META_PATH, "w") as f:
        json.dump(meta, f, indent=2)

    print(f"\n[semantic] Model saved → {MODEL_PATH}")
    return bundle


# --------------------------------------------------------------------------- #
# Inference / prediction
# --------------------------------------------------------------------------- #

def predict(text: str):
    import joblib

    if not os.path.exists(MODEL_PATH):
        print(f"[error] No model found at {MODEL_PATH}. Train first.")
        sys.exit(1)

    with open(META_PATH) as f:
        meta = json.load(f)

    bundle = joblib.load(MODEL_PATH)
    mtype = meta["type"]

    if mtype == "tfidf":
        pipeline = bundle
        probs = pipeline.predict_proba([text])[0]
        classes = pipeline.classes_
    elif mtype == "semantic":
        from sentence_transformers import SentenceTransformer
        encoder = SentenceTransformer(bundle["encoder_name"])
        clf = bundle["clf"]
        vec = encoder.encode([text], convert_to_numpy=True)
        probs = clf.predict_proba(vec)[0]
        classes = clf.classes_
    else:
        print(f"[error] Unknown model type: {mtype}")
        sys.exit(1)

    ranked = sorted(zip(classes, probs), key=lambda x: -x[1])
    print(f"\nInput: \"{text}\"")
    print("Predictions:")
    for label, prob in ranked:
        bar = "█" * int(prob * 30)
        print(f"  {label:<14}  {prob:.1%}  {bar}")
    print(f"\nBest match: {ranked[0][0]}")


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

def main():
    parser = argparse.ArgumentParser(description="Train/use the Town Hall notes classifier")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--data",       help="Path to labeled CSV (text,label)")
    group.add_argument("--predict",    help="Classify a single string without training")
    parser.add_argument("--model-type", choices=["tfidf", "semantic"], default="tfidf",
                        help="Model backend (default: tfidf)")
    parser.add_argument("--test-size",  type=float, default=0.2,
                        help="Fraction held out for evaluation (default: 0.2)")
    args = parser.parse_args()

    # If no primary mode provided, show help and exit successfully
    if not args.data and not args.predict:
        parser.print_help()
        sys.exit(0)

    if args.predict:
        predict(args.predict)
        return

    if not os.path.exists(args.data):
        print(f"[error] File not found: {args.data}")
        sys.exit(1)

    print(f"Loading data from: {args.data}")
    texts, labels = load_csv(args.data)

    if len(texts) == 0:
        print("[error] No valid rows found in CSV.")
        sys.exit(1)

    print(f"Loaded {len(texts)} samples across labels: {sorted(set(labels))}")

    if args.model_type == "tfidf":
        train_tfidf(texts, labels, test_size=args.test_size)
    else:
        train_semantic(texts, labels, test_size=args.test_size)

    print("\nDone. To classify new notes, run:")
    print(f'  python train_classifier.py --predict "your note text here"')


if __name__ == "__main__":
    main()

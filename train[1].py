from __future__ import annotations

import json
import logging
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score, accuracy_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

import lightgbm as lgb

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                    datefmt="%Y-%m-%d %H:%M:%S")
log = logging.getLogger("train")

DATA_PATH = Path("credit_risk_dataset.csv")
MODELS_DIR = Path("models")
MODELS_DIR.mkdir(exist_ok=True)

LOGISTIC_NUMERIC_FEATURES = [
    "person_age",
    "person_income",
    "person_emp_length",
    "loan_percent_income",
    "cb_person_cred_hist_length",
]
LGBM_NUMERIC_FEATURES = LOGISTIC_NUMERIC_FEATURES + ["loan_amnt"]
CATEGORICAL_FEATURES = ["person_home_ownership", "cb_person_default_on_file"]
TARGET = "loan_status"


def load_and_clean() -> pd.DataFrame:
    df = pd.read_csv(DATA_PATH)
    n0 = len(df)
    df = df[df["person_age"] <= 100]
    df = df[df["person_emp_length"] <= 60]
    log.info("Dropped %d implausible rows", n0 - len(df))
    cols = LGBM_NUMERIC_FEATURES + CATEGORICAL_FEATURES + [TARGET]
    df = df[cols].copy()
    log.info("Final shape: %s | default rate %.1f%%", df.shape, df[TARGET].mean() * 100)
    return df


def make_preprocessor(numeric_features):
    numeric_pipe = Pipeline([
        ("impute", SimpleImputer(strategy="median")),
        ("scale", StandardScaler()),
    ])
    categorical_pipe = Pipeline([
        ("impute", SimpleImputer(strategy="most_frequent")),
        ("onehot", OneHotEncoder(handle_unknown="ignore", drop="first")),
    ])
    return ColumnTransformer([
        ("num", numeric_pipe, numeric_features),
        ("cat", categorical_pipe, CATEGORICAL_FEATURES),
    ])


def export_logistic_formula(preprocessor, logreg):
    num_names = LOGISTIC_NUMERIC_FEATURES
    ohe = preprocessor.named_transformers_["cat"].named_steps["onehot"]
    cat_names = list(ohe.get_feature_names_out(CATEGORICAL_FEATURES))
    feature_names = list(num_names) + cat_names

    coefs = logreg.coef_[0]
    intercept = float(logreg.intercept_[0])

    label_map = {
        "person_age": "Umur",
        "person_income": "Pendapatan",
        "person_emp_length": "Lama Bekerja",
        "loan_percent_income": "Rasio Cicilan (DTI)",
        "cb_person_cred_hist_length": "Lama Riwayat Kredit",
        "person_home_ownership_OTHER": "Rumah: Lainnya",
        "person_home_ownership_OWN": "Rumah: Milik Sendiri",
        "person_home_ownership_RENT": "Rumah: Sewa",
        "cb_person_default_on_file_Y": "Pernah Gagal Bayar",
    }

    terms = []
    for name, c in zip(feature_names, coefs):
        terms.append({
            "feature": name,
            "label": label_map.get(name, name),
            "coefficient": round(float(c), 6),
            "direction": "increases risk" if c > 0 else "decreases risk",
        })

    formula = {
        "intercept": round(intercept, 6),
        "terms": terms,
        "note": "PD = 1 / (1 + e^-z),  z = intercept + sum(coef * standardized_feature)",
    }
    (MODELS_DIR / "logistic_coefficients.json").write_text(json.dumps(formula, indent=2))
    ranked = sorted(terms, key=lambda t: abs(t["coefficient"]), reverse=True)
    log.info("Logistic drivers:")
    for t in ranked:
        arrow = "UP" if t["coefficient"] > 0 else "DN"
        log.info("   %s %-22s coef=%+.3f", arrow, t["label"], t["coefficient"])


def main():
    df = load_and_clean()
    y = df[TARGET]

    X_log = df[LOGISTIC_NUMERIC_FEATURES + CATEGORICAL_FEATURES]
    X_lgb = df[LGBM_NUMERIC_FEATURES + CATEGORICAL_FEATURES]

    Xl_tr, Xl_te, y_tr, y_te = train_test_split(X_log, y, test_size=0.2, random_state=42, stratify=y)
    Xg_tr, Xg_te, _, _ = train_test_split(X_lgb, y, test_size=0.2, random_state=42, stratify=y)

    pre_log = make_preprocessor(LOGISTIC_NUMERIC_FEATURES)
    Xl_tr_t = pre_log.fit_transform(Xl_tr)
    Xl_te_t = pre_log.transform(Xl_te)

    logreg = LogisticRegression(max_iter=2000, class_weight="balanced", C=1.0)
    logreg.fit(Xl_tr_t, y_tr)
    pd_lr = logreg.predict_proba(Xl_te_t)[:, 1]
    log.info("Logistic AUC %.3f acc %.3f", roc_auc_score(y_te, pd_lr),
             accuracy_score(y_te, (pd_lr >= 0.5).astype(int)))

    pre_lgb = make_preprocessor(LGBM_NUMERIC_FEATURES)
    Xg_tr_t = pre_lgb.fit_transform(Xg_tr)
    Xg_te_t = pre_lgb.transform(Xg_te)

    lgbm = lgb.LGBMClassifier(
        n_estimators=300, learning_rate=0.05, max_depth=6,
        num_leaves=31, subsample=0.8, colsample_bytree=0.8,
        class_weight="balanced", random_state=42, verbose=-1,
    )
    lgbm.fit(Xg_tr_t, y_tr)
    pd_lgb = lgbm.predict_proba(Xg_te_t)[:, 1]
    log.info("LightGBM AUC %.3f acc %.3f", roc_auc_score(y_te, pd_lgb),
             accuracy_score(y_te, (pd_lgb >= 0.5).astype(int)))

    joblib.dump(pre_log, MODELS_DIR / "preprocessor.pkl")
    joblib.dump(pre_lgb, MODELS_DIR / "preprocessor_lgbm.pkl")
    joblib.dump(logreg, MODELS_DIR / "logistic_model.pkl")
    joblib.dump(lgbm, MODELS_DIR / "lgbm_validator.pkl")
    export_logistic_formula(pre_log, logreg)

    meta = {
        "logistic_numeric_features": LOGISTIC_NUMERIC_FEATURES,
        "lgbm_numeric_features": LGBM_NUMERIC_FEATURES,
        "categorical_features": CATEGORICAL_FEATURES,
        "logistic_auc": round(float(roc_auc_score(y_te, pd_lr)), 4),
        "lgbm_auc": round(float(roc_auc_score(y_te, pd_lgb)), 4),
        "default_rate": round(float(y.mean()), 4),
        "n_rows": int(len(df)),
    }
    (MODELS_DIR / "model_meta.json").write_text(json.dumps(meta, indent=2))
    log.info("Done.")


if __name__ == "__main__":
    main()

from __future__ import annotations

import json
import logging
import math
import re
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, List

import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Header, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("safecredit")

MODELS_DIR = Path("models")

HOUSING_EXPENSE_RATIO_LIMIT = 0.28
TOTAL_DEBT_OBLIGATION_RATIO_LIMIT = 0.36
FRONT_END_DTI_LIMIT = HOUSING_EXPENSE_RATIO_LIMIT
BACK_END_DTI_LIMIT = TOTAL_DEBT_OBLIGATION_RATIO_LIMIT
PD_THRESHOLD = 0.20
ML_AGREEMENT_TOLERANCE = 0.10

BASE_ANNUAL_RATE = 0.18

SIZE_PREMIUM_PER_10K = 0.01
SIZE_PREMIUM_CAP = 0.12

TENOR_PREMIUM_PER_12MO = 0.015
TENOR_PREMIUM_CAP = 0.06


RESTRUCTURE_STEP_USD = 500
RESTRUCTURE_MIN_USD = 1_000

SCORE_MIN, SCORE_MAX = 300, 850
LENDER_INITIAL_FUNDS = 0.0

LOGISTIC_NUMERIC_FEATURES = [
    "person_age", "person_income", "person_emp_length",
    "loan_percent_income", "cb_person_cred_hist_length",
]
LGBM_NUMERIC_FEATURES = LOGISTIC_NUMERIC_FEATURES + ["loan_amnt"]
CATEGORICAL_FEATURES = ["person_home_ownership", "cb_person_default_on_file"]
LGBM_ALL_FEATURES = LGBM_NUMERIC_FEATURES + CATEGORICAL_FEATURES

ARTIFACTS: dict = {}

LOANS_DB: List[dict] = []
LENDERS_DB: dict = {}
USERS_DB: dict = {}
KYC_DB: dict = {}
BORROWERS_DB: dict = {}


def _seed_admin():
    USERS_DB["admin"] = {
        "password": "admin",
        "role": "admin",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


_seed_admin()


def _ensure_lender(email: str):
    if email not in LENDERS_DB:
        LENDERS_DB[email] = {"idle_funds": LENDER_INITIAL_FUNDS}


def _ensure_borrower(email: str):
    if email not in BORROWERS_DB:
        BORROWERS_DB[email] = {"balance": 0.0}


@asynccontextmanager
async def lifespan(app: FastAPI):
    required = ["preprocessor.pkl", "preprocessor_lgbm.pkl", "logistic_model.pkl",
                "lgbm_validator.pkl", "logistic_coefficients.json", "model_meta.json"]
    missing = [f for f in required if not (MODELS_DIR / f).exists()]
    if missing:
        raise RuntimeError(f"Missing artifacts: {missing}. Run train.py first.")
    ARTIFACTS["preprocessor"] = joblib.load(MODELS_DIR / "preprocessor.pkl")
    ARTIFACTS["preprocessor_lgbm"] = joblib.load(MODELS_DIR / "preprocessor_lgbm.pkl")
    ARTIFACTS["logistic_model"] = joblib.load(MODELS_DIR / "logistic_model.pkl")
    ARTIFACTS["lgbm_validator"] = joblib.load(MODELS_DIR / "lgbm_validator.pkl")
    ARTIFACTS["logistic_coefficients"] = json.loads(
        (MODELS_DIR / "logistic_coefficients.json").read_text())
    ARTIFACTS["model_meta"] = json.loads((MODELS_DIR / "model_meta.json").read_text())
    log.info("SafeCredit ready.")
    yield
    log.info("SafeCredit shutting down.")


app = FastAPI(title="SafeCredit API", version="1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)


class RegisterRequest(BaseModel):
    email: str = Field(..., min_length=1)
    password: str = Field(..., min_length=1)
    role: str = Field(...)

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        v = v.strip().lower()
        if "@" not in v or "." not in v.split("@", 1)[1]:
            raise ValueError("Format email tidak valid.")
        return v

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: str) -> str:
        v = v.strip().lower()
        if v not in ("peminjam", "pendana"):
            raise ValueError("Role harus 'peminjam' atau 'pendana'.")
        return v


class LoginRequest(BaseModel):
    email: str = Field(..., min_length=1)
    password: str = Field(..., min_length=1)


class AuthResponse(BaseModel):
    success: bool
    message: str
    email: str
    role: str


class KYCRequest(BaseModel):
    email: str
    full_name: str = Field(..., min_length=1)
    nik: str = Field(..., min_length=1)
    address: str = Field(..., min_length=1)
    rt_rw: str = Field(..., min_length=1)
    kelurahan: str = Field(..., min_length=1)
    kecamatan: str = Field(..., min_length=1)

    @field_validator("nik")
    @classmethod
    def validate_nik(cls, v: str) -> str:
        v = v.strip()
        if not re.fullmatch(r"\d{16}", v):
            raise ValueError("NIK harus 16 digit angka.")
        return v

    @field_validator("rt_rw")
    @classmethod
    def validate_rtrw(cls, v: str) -> str:
        v = v.strip()
        if not re.fullmatch(r"\d{1,3}/\d{1,3}", v):
            raise ValueError("Format RT/RW contoh: 003/007.")
        return v


class KYCResponse(BaseModel):
    success: bool
    message: str
    email: str
    verified: bool


class KYCStatusResponse(BaseModel):
    email: str
    verified: bool
    full_name: Optional[str] = None


class LoanRequest(BaseModel):
    annual_income: float = Field(..., gt=0)
    coapplicant_income: float = Field(0.0, ge=0)
    other_monthly_debt: float = Field(0.0, ge=0)
    age: int = Field(..., ge=18, le=100)
    years_employment_experience: int = Field(..., ge=0, le=60)
    credit_history_length: int = Field(..., ge=0, le=60)
    is_self_employed: str = Field(...)
    has_previous_default: str = Field(...)
    home_ownership: str = Field(...)
    loan_amount: float = Field(..., gt=0)
    tenor_months: int = Field(..., gt=0)
    loan_intent: str = Field("PERSONAL")

    @property
    def household_monthly_income(self) -> float:
        return (self.annual_income + self.coapplicant_income) / 12.0

    @field_validator("is_self_employed", "has_previous_default")
    @classmethod
    def validate_yes_no(cls, v: str) -> str:
        if v not in ("Yes", "No"):
            raise ValueError("Must be 'Yes' or 'No'.")
        return v

    @field_validator("home_ownership")
    @classmethod
    def validate_home(cls, v: str) -> str:
        valid = {"RENT", "OWN", "MORTGAGE", "OTHER"}
        if v.upper() not in valid:
            raise ValueError(f"Must be one of {valid}.")
        return v.upper()


class FormulaTerm(BaseModel):
    label: str
    coefficient: float
    contribution: float
    direction: str


class AssessmentDetail(BaseModel):
    housing_expense_ratio: float
    total_debt_obligation_ratio: float
    housing_expense_pass: bool
    debt_obligation_pass: bool
    household_monthly_income: float
    monthly_installment: float
    annual_interest_rate: float
    pd_formula: float
    pd_pass: bool
    z_value: float
    top_factors: List[FormulaTerm]
    credit_score: int
    score_band: str
    pd_ml: float
    ml_agrees: bool
    agreement_gap: float
    is_safe: bool
    risk_label: str
    effective_risk: float

    @property
    def front_end_dti(self) -> float:
        return self.housing_expense_ratio

    @property
    def back_end_dti(self) -> float:
        return self.total_debt_obligation_ratio

    @property
    def front_end_pass(self) -> bool:
        return self.housing_expense_pass

    @property
    def back_end_pass(self) -> bool:
        return self.debt_obligation_pass


class SimulateResponse(AssessmentDetail):
    requested_loan_amount: float


class ApplyResponse(BaseModel):
    application_status: str
    requested_loan_amount: float
    approved_loan_amount: float
    is_requested_safe: bool
    recommended_amount: float
    recommended_installment: float
    recommended_total_debt_ratio: float
    recommended_pd: float
    assessment: AssessmentDetail
    tenor_months: int
    llm_narrative: str


class LoanCreate(BaseModel):
    borrower_email: str
    loan_amount: float = Field(..., gt=0)
    tenor_months: int = Field(..., gt=0)
    monthly_installment: float = Field(..., ge=0)
    annual_interest_rate: float = Field(..., ge=0)
    probability_of_default: float = Field(..., ge=0, le=1)
    dti_ratio: float = Field(..., ge=0)
    generated_credit_score: int = Field(..., ge=300, le=850)
    top_feature_label: str
    direction: str
    risk_label: str
    ml_agrees: bool = True
    forced_high_risk: bool = False


class LoanRecord(BaseModel):
    loan_id: str
    borrower_email: str
    loan_amount: float
    tenor_months: int
    monthly_installment: float
    annual_interest_rate: float = 0.08
    probability_of_default: float
    dti_ratio: float
    generated_credit_score: int
    top_feature_label: str
    direction: str
    risk_label: str
    ml_agrees: bool = True
    forced_high_risk: bool
    status: str
    funded_by: Optional[str] = None
    total_installments: int = 0
    paid_installments: int = 0
    on_time_payments: int = 0
    late_payments: int = 0
    success_rate: float = 100.0
    created_at: str
    next_payment_due: Optional[str] = None


class FundResponse(BaseModel):
    success: bool
    message: str
    loan: LoanRecord


class PortfolioStats(BaseModel):
    lender_email: str
    idle_funds: float
    total_invested: float
    borrower_count: int
    loans_count: int
    total_interest_projected: float
    projected_roi_percent: float
    funded_loans: List[LoanRecord]


class TopUpRequest(BaseModel):
    email: str
    amount: float = Field(..., gt=0)
    source: str = Field("rekening")


class WithdrawRequest(BaseModel):
    email: str
    amount: float = Field(..., gt=0)
    destination: str = Field("rekening")


class BalanceResponse(BaseModel):
    email: str
    balance: float


def calc_annual_rate(loan_amount: float, tenor_months: int) -> float:
    size_premium = min((loan_amount / 10_000.0) * SIZE_PREMIUM_PER_10K, SIZE_PREMIUM_CAP)
    tenor_premium = min((tenor_months / 12.0) * TENOR_PREMIUM_PER_12MO, TENOR_PREMIUM_CAP)
    return round(BASE_ANNUAL_RATE + size_premium + tenor_premium, 6)


def calc_monthly_installment(loan_amount: float, tenor_months: int) -> float:
    annual_rate = calc_annual_rate(loan_amount, tenor_months)
    r = annual_rate / 12.0
    n = tenor_months
    if r == 0:
        return round(loan_amount / n, 2)
    factor = (r * (1 + r) ** n) / ((1 + r) ** n - 1)
    return round(loan_amount * factor, 2)


def _standardize(raw_value: float, feature_name: str) -> float:
    pre = ARTIFACTS["preprocessor"]
    scaler = pre.named_transformers_["num"].named_steps["scale"]
    idx = LOGISTIC_NUMERIC_FEATURES.index(feature_name)
    mean = scaler.mean_[idx]
    scale = scaler.scale_[idx]
    return (raw_value - mean) / scale if scale else 0.0


def _annualized_loan_ratio(req: LoanRequest, loan_amount: float) -> float:
    total_annual = req.annual_income + req.coapplicant_income
    return round(loan_amount / total_annual, 4) if total_annual > 0 else 1.0


def calc_2836_rule(req: LoanRequest, loan_amount: float):
    gross = req.household_monthly_income
    installment = calc_monthly_installment(loan_amount, req.tenor_months)
    front_end = installment / gross if gross > 0 else 1.0
    back_end = (installment + req.other_monthly_debt) / gross if gross > 0 else 1.0
    return {
        "installment": installment,
        "front_end": round(front_end, 4),
        "back_end": round(back_end, 4),
        "front_pass": front_end <= FRONT_END_DTI_LIMIT,
        "back_pass": back_end <= BACK_END_DTI_LIMIT,
        "gross": gross,
    }


def calc_logistic_pd(req: LoanRequest, loan_ratio: float):
    coeffs = ARTIFACTS["logistic_coefficients"]
    z = coeffs["intercept"]
    raw_values = {
        "person_age": req.age,
        "person_income": req.annual_income + req.coapplicant_income,
        "person_emp_length": req.years_employment_experience,
        "loan_percent_income": loan_ratio,
        "cb_person_cred_hist_length": req.credit_history_length,
    }
    contributions = []
    for term in coeffs["terms"]:
        feat = term["feature"]
        coef = term["coefficient"]
        if feat in LOGISTIC_NUMERIC_FEATURES:
            contrib = coef * _standardize(raw_values[feat], feat)
        else:
            contrib = 0.0
            if feat == "person_home_ownership_OWN" and req.home_ownership == "OWN":
                contrib = coef
            elif feat == "person_home_ownership_RENT" and req.home_ownership == "RENT":
                contrib = coef
            elif feat == "person_home_ownership_OTHER" and req.home_ownership == "OTHER":
                contrib = coef
            elif feat == "cb_person_default_on_file_Y" and req.has_previous_default == "Yes":
                contrib = coef
        z += contrib
        contributions.append({
            "label": term["label"],
            "coefficient": round(coef, 4),
            "contribution": round(contrib, 4),
            "direction": "increases risk" if contrib > 0 else "decreases risk",
        })
    pd_value = 1.0 / (1.0 + math.exp(-z))
    top = sorted([c for c in contributions if abs(c["contribution"]) > 1e-6],
                 key=lambda c: abs(c["contribution"]), reverse=True)[:4]
    return round(pd_value, 6), round(z, 4), top


def pd_to_score(pd_value: float):
    pd_clamped = min(max(pd_value, 1e-6), 1 - 1e-6)
    odds = (1 - pd_clamped) / pd_clamped
    score = int(max(SCORE_MIN, min(SCORE_MAX, round(600.0 + 40.0 * math.log(odds)))))
    if score >= 750:
        band = "Excellent"
    elif score >= 700:
        band = "Good"
    elif score >= 650:
        band = "Fair"
    elif score >= 580:
        band = "Poor"
    else:
        band = "Very Poor"
    return score, band


def ml_validate(req: LoanRequest, loan_amount: float, loan_ratio: float, pd_formula: float):
    row = {
        "person_age": req.age,
        "person_income": req.annual_income + req.coapplicant_income,
        "person_emp_length": req.years_employment_experience,
        "loan_percent_income": loan_ratio,
        "cb_person_cred_hist_length": req.credit_history_length,
        "loan_amnt": loan_amount,
        "person_home_ownership": req.home_ownership,
        "cb_person_default_on_file": "Y" if req.has_previous_default == "Yes" else "N",
    }
    df = pd.DataFrame([row], columns=LGBM_ALL_FEATURES)
    X = ARTIFACTS["preprocessor_lgbm"].transform(df)
    pd_ml = float(ARTIFACTS["lgbm_validator"].predict_proba(X)[0, 1])
    gap = abs(pd_ml - pd_formula)
    return round(pd_ml, 6), gap <= ML_AGREEMENT_TOLERANCE, round(gap, 6)


def calc_overall_risk(pd_formula: float, back_end_dti: float, tenor_months: int) -> float:
    pd_component = min(pd_formula, 1.0)

    DTI_CEILING = BACK_END_DTI_LIMIT
    dti_component = min(back_end_dti / (DTI_CEILING * 2.0), 1.0)

    overall = (0.60 * pd_component) + (0.40 * dti_component)
    return round(min(overall, 1.0), 6)


def assess_loan(req: LoanRequest, loan_amount: float) -> AssessmentDetail:
    rule = calc_2836_rule(req, loan_amount)
    loan_ratio = _annualized_loan_ratio(req, loan_amount)
    pd_formula, z_value, top_factors = calc_logistic_pd(req, loan_ratio)
    pd_pass = pd_formula <= PD_THRESHOLD
    score, band = pd_to_score(pd_formula)
    pd_ml, ml_agrees, gap = ml_validate(req, loan_amount, loan_ratio, pd_formula)
    is_safe = rule["back_pass"] and rule["front_pass"] and pd_pass
    overall_risk = calc_overall_risk(pd_formula, rule["back_end"], req.tenor_months)
    return AssessmentDetail(
        housing_expense_ratio=rule["front_end"],
        total_debt_obligation_ratio=rule["back_end"],
        housing_expense_pass=rule["front_pass"],
        debt_obligation_pass=rule["back_pass"],
        household_monthly_income=round(rule["gross"], 2),
        monthly_installment=rule["installment"],
        annual_interest_rate=calc_annual_rate(loan_amount, req.tenor_months),
        pd_formula=pd_formula,
        pd_pass=pd_pass,
        z_value=z_value,
        top_factors=[FormulaTerm(**t) for t in top_factors],
        credit_score=score,
        score_band=band,
        pd_ml=pd_ml,
        ml_agrees=ml_agrees,
        agreement_gap=gap,
        is_safe=is_safe,
        risk_label="LOW RISK" if is_safe else "HIGH RISK",
        effective_risk=overall_risk,
    )


def build_narrative_context(req, requested_amount, approved_amount, assessment, was_restructured):
    home_map = {"RENT": "menyewa", "OWN": "milik sendiri", "MORTGAGE": "KPR", "OTHER": "lainnya"}
    top_factor = assessment.top_factors[0].label if assessment.top_factors else "Rasio Cicilan (DTI)"
    top_dir = assessment.top_factors[0].direction if assessment.top_factors else "increases risk"
    return {
        "pendapatan_tahunan_usd": round(req.annual_income),
        "pendapatan_bulanan_usd": round(req.household_monthly_income),
        "utang_lain_bulanan_usd": round(req.other_monthly_debt),
        "umur": req.age,
        "status_pekerjaan": "wiraswasta" if req.is_self_employed == "Yes" else "karyawan",
        "pengalaman_kerja_tahun": req.years_employment_experience,
        "riwayat_kredit_macet": "pernah" if req.has_previous_default == "Yes" else "tidak pernah",
        "kepemilikan_rumah": home_map.get(req.home_ownership, req.home_ownership),
        "skor_kredit": assessment.credit_score,
        "band_skor": assessment.score_band,
        "jumlah_diminta_usd": round(requested_amount),
        "jumlah_disetujui_usd": round(approved_amount),
        "tenor_bulan": req.tenor_months,
        "bunga_tahunan_persen": round(assessment.annual_interest_rate * 100, 2),
        "cicilan_bulanan_usd": round(assessment.monthly_installment),
        "front_end_dti_persen": round(assessment.front_end_dti * 100, 1),
        "back_end_dti_persen": round(assessment.back_end_dti * 100, 1),
        "pd_rumus_persen": round(assessment.pd_formula * 100, 1),
        "pd_ml_persen": round(assessment.pd_ml * 100, 1),
        "ml_setuju": assessment.ml_agrees,
        "direstrukturisasi": was_restructured,
        "faktor_utama": top_factor,
        "arah_faktor": "menurunkan risiko" if top_dir == "decreases risk" else "meningkatkan risiko",
    }


def _fallback_narrative(ctx, was_restructured):
    diminta = ctx["jumlah_diminta_usd"]
    disetujui = ctx["jumlah_disetujui_usd"]
    tenor = ctx["tenor_bulan"]
    cicilan = ctx["cicilan_bulanan_usd"]
    bunga = ctx["bunga_tahunan_persen"]
    be_dti = ctx["back_end_dti_persen"]
    pd_r = ctx["pd_rumus_persen"]
    pd_ml = ctx["pd_ml_persen"]
    income_yr = ctx["pendapatan_tahunan_usd"]
    skor = ctx["skor_kredit"]
    band = ctx["band_skor"]
    faktor = ctx["faktor_utama"]
    arah = ctx["arah_faktor"]
    ml_setuju = ctx["ml_setuju"]
    p1 = (f"Pendapatan tahunan Anda sekitar USD {income_yr:,}, atau sekitar USD "
          f"{ctx['pendapatan_bulanan_usd']:,} per bulan. Berdasarkan profil ini kami menilai "
          f"keterjangkauan dan risiko pinjaman Anda secara transparan.")
    if was_restructured:
        p2 = (f"Anda mengajukan USD {diminta:,} untuk tenor {tenor} bulan. Pada jumlah itu "
              f"rasio cicilan total mencapai {be_dti}% dari penghasilan, melewati batas aman "
              f"36% pada Aturan 28/36. Karena itu sistem merekomendasikan USD {disetujui:,} "
              f"dengan cicilan sekitar USD {cicilan:,} per bulan (bunga {bunga}%/tahun).")
    else:
        p2 = (f"Anda mengajukan USD {disetujui:,} untuk tenor {tenor} bulan, dengan cicilan "
              f"sekitar USD {cicilan:,} per bulan (bunga {bunga}%/tahun). Rasio cicilan total "
              f"Anda {be_dti}% — masih dalam batas sehat Aturan 28/36, sehingga terjangkau.")
    p3 = (f"Probabilitas gagal bayar menurut rumus logistik kami {pd_r}%, dan skor kredit Anda "
          f"{skor} ({band}). Faktor paling berpengaruh adalah '{faktor}', yang {arah}. "
          + ("Validasi model ML kami setuju dengan rumus, sehingga keyakinan tinggi."
             if ml_setuju else
             f"Model ML kami memberi estimasi berbeda ({pd_ml}%), jadi hasil perlu ditinjau."))
    tips = ("Tips: (1) Jaga rasio cicilan total di bawah 36%. (2) "
            + ("Pertimbangkan tenor lebih panjang untuk menurunkan cicilan. "
               if be_dti > 30 else "Pertahankan rasio cicilan yang sehat. ")
            + "(3) Bayar tepat waktu untuk memperkuat riwayat kredit Anda.")
    return f"{p1}\n\n{p2}\n\n{p3}\n\n{tips}"


@app.post("/api/auth/register", response_model=AuthResponse, tags=["Auth"])
async def register_user(payload: RegisterRequest):
    email = payload.email
    if email in USERS_DB:
        raise HTTPException(status_code=409, detail=f"Email '{email}' sudah terdaftar. Silakan login.")
    USERS_DB[email] = {"password": payload.password, "role": payload.role,
                       "created_at": datetime.now(timezone.utc).isoformat()}
    return AuthResponse(success=True, message="Pendaftaran berhasil. Silakan login.",
                        email=email, role=payload.role)


@app.post("/api/auth/login", response_model=AuthResponse, tags=["Auth"])
async def login_user(payload: LoginRequest):
    email = payload.email.strip().lower()
    user = USERS_DB.get(email)
    if user is None or user["password"] != payload.password:
        raise HTTPException(status_code=401, detail="Email atau password salah.")
    return AuthResponse(success=True, message="Login berhasil.", email=email, role=user["role"])


@app.post("/api/kyc/submit", response_model=KYCResponse, tags=["KYC"])
async def submit_kyc(payload: KYCRequest):
    email = payload.email.strip().lower()
    KYC_DB[email] = {
        "full_name": payload.full_name, "nik": payload.nik, "address": payload.address,
        "rt_rw": payload.rt_rw, "kelurahan": payload.kelurahan, "kecamatan": payload.kecamatan,
        "verified": True, "submitted_at": datetime.now(timezone.utc).isoformat(),
    }
    return KYCResponse(success=True, message="Identitas terverifikasi & tersimpan.",
                       email=email, verified=True)


@app.get("/api/kyc/status", response_model=KYCStatusResponse, tags=["KYC"])
async def kyc_status(email: str):
    email = email.strip().lower()
    rec = KYC_DB.get(email)
    if not rec:
        return KYCStatusResponse(email=email, verified=False)
    return KYCStatusResponse(email=email, verified=rec["verified"], full_name=rec["full_name"])


@app.post("/api/loan/simulate", response_model=SimulateResponse, tags=["Loan Engine"])
async def simulate_loan(req: LoanRequest):
    a = assess_loan(req, req.loan_amount)
    return SimulateResponse(requested_loan_amount=req.loan_amount, **a.model_dump())


@app.post("/api/loan/apply", response_model=ApplyResponse, tags=["Loan Engine"])
async def apply_loan(req: LoanRequest):
    requested_amount = req.loan_amount
    assessment = assess_loan(req, requested_amount)
    is_requested_safe = assessment.is_safe
    if is_requested_safe:
        rec_amount = requested_amount
        rec = assessment
        app_status = "APPROVED"
    else:
        rec_amount = None
        rec = assessment
        amount = requested_amount - RESTRUCTURE_STEP_USD
        while amount >= RESTRUCTURE_MIN_USD:
            cand = assess_loan(req, amount)
            if cand.is_safe:
                rec_amount = amount
                rec = cand
                break
            amount -= RESTRUCTURE_STEP_USD
        if rec_amount is None:
            rec_amount = RESTRUCTURE_MIN_USD
            rec = assess_loan(req, RESTRUCTURE_MIN_USD)
            app_status = "UNFUNDABLE"
        else:
            app_status = "NEEDS_RESTRUCTURE"
    ctx = build_narrative_context(req, requested_amount, requested_amount,
                                   assessment, not is_requested_safe)
    narrative = _fallback_narrative(ctx, not is_requested_safe)
    return ApplyResponse(
        application_status=app_status,
        requested_loan_amount=requested_amount,
        approved_loan_amount=rec_amount,
        is_requested_safe=is_requested_safe,
        recommended_amount=rec_amount,
        recommended_installment=rec.monthly_installment,
        recommended_total_debt_ratio=round(rec.total_debt_obligation_ratio, 6),
        recommended_pd=round(rec.pd_formula, 6),
        assessment=assessment,
        tenor_months=req.tenor_months,
        llm_narrative=narrative,
    )


@app.post("/api/loans/apply", response_model=LoanRecord, tags=["P2P Marketplace"])
async def create_loan(payload: LoanCreate):
    email = payload.borrower_email.strip().lower()
    kyc = KYC_DB.get(email)
    if not kyc or not kyc.get("verified"):
        raise HTTPException(status_code=403,
                            detail="Anda harus menyelesaikan verifikasi KYC sebelum mengajukan pinjaman.")
    loan_id = "LN-" + uuid.uuid4().hex[:8].upper()
    record = {
        "loan_id": loan_id,
        "borrower_email": email,
        "loan_amount": payload.loan_amount,
        "tenor_months": payload.tenor_months,
        "monthly_installment": payload.monthly_installment,
        "annual_interest_rate": payload.annual_interest_rate,
        "probability_of_default": payload.probability_of_default,
        "dti_ratio": payload.dti_ratio,
        "generated_credit_score": payload.generated_credit_score,
        "top_feature_label": payload.top_feature_label,
        "direction": payload.direction,
        "risk_label": payload.risk_label,
        "ml_agrees": payload.ml_agrees,
        "forced_high_risk": payload.forced_high_risk,
        "status": "Pending",
        "funded_by": None,
        "total_installments": payload.tenor_months,
        "paid_installments": 0,
        "on_time_payments": 0,
        "late_payments": 0,
        "success_rate": 100.0,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "next_payment_due": None,
    }
    LOANS_DB.append(record)
    return LoanRecord(**record)


@app.get("/api/loans/marketplace", response_model=List[LoanRecord], tags=["P2P Marketplace"])
async def get_marketplace():
    pending = [LoanRecord(**l) for l in LOANS_DB if l["status"] == "Pending"]
    pending.reverse()
    return pending


@app.get("/api/loans/my-dashboard", response_model=List[LoanRecord], tags=["P2P Marketplace"])
async def get_my_dashboard(email: str):
    email = email.strip().lower()
    mine = [LoanRecord(**l) for l in LOANS_DB if l["borrower_email"] == email]
    mine.reverse()
    return mine


@app.post("/api/loans/fund/{loan_id}", response_model=FundResponse, tags=["P2P Marketplace"])
async def fund_loan(loan_id: str, lender_email: str):
    lender_email = lender_email.strip().lower()
    _ensure_lender(lender_email)
    for loan in LOANS_DB:
        if loan["loan_id"] == loan_id:
            if loan["status"] != "Pending":
                raise HTTPException(status_code=409,
                                    detail=f"Pinjaman {loan_id} sudah tidak tersedia.")
            idle = LENDERS_DB[lender_email]["idle_funds"]
            principal = loan["loan_amount"]
            if principal > idle:
                raise HTTPException(status_code=402,
                                    detail=f"Dana menganggur Anda ${idle:,.0f} tidak cukup untuk mendanai ${principal:,.0f}. Silakan top-up dahulu.")
            LENDERS_DB[lender_email]["idle_funds"] = round(idle - principal, 2)
            _ensure_borrower(loan["borrower_email"])
            BORROWERS_DB[loan["borrower_email"]]["balance"] = round(
                BORROWERS_DB[loan["borrower_email"]]["balance"] + principal, 2)
            loan["status"] = "Accepted (On-Going)"
            loan["funded_by"] = lender_email
            from datetime import timedelta
            loan["next_payment_due"] = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
            return FundResponse(success=True,
                                message=f"Pinjaman {loan_id} didanai. Dana ${principal:,.0f} masuk ke saldo peminjam.",
                                loan=LoanRecord(**loan))
    raise HTTPException(status_code=404, detail=f"Pinjaman {loan_id} tidak ditemukan.")


@app.get("/api/loans/my-portfolio", response_model=PortfolioStats, tags=["P2P Marketplace"])
async def get_my_portfolio(lender_email: str):
    lender_email = lender_email.strip().lower()
    _ensure_lender(lender_email)
    funded = [l for l in LOANS_DB if l.get("funded_by") == lender_email]
    funded.sort(key=lambda l: l["created_at"], reverse=True)
    total_invested = sum(l["loan_amount"] for l in funded)
    borrower_count = len({l["borrower_email"] for l in funded})
    total_interest = 0.0
    for l in funded:
        total_paid = l["monthly_installment"] * l["tenor_months"]
        total_interest += max(total_paid - l["loan_amount"], 0)
    if total_invested > 0:
        weighted_years = sum((l["loan_amount"] * l["tenor_months"] / 12.0) for l in funded) / total_invested
        annualized_roi = (total_interest / total_invested) / max(weighted_years, 0.01) * 100
    else:
        annualized_roi = 0.0
    return PortfolioStats(
        lender_email=lender_email,
        idle_funds=round(LENDERS_DB[lender_email]["idle_funds"], 2),
        total_invested=round(total_invested, 2),
        borrower_count=borrower_count,
        loans_count=len(funded),
        total_interest_projected=round(total_interest, 2),
        projected_roi_percent=round(annualized_roi, 2),
        funded_loans=[LoanRecord(**l) for l in funded],
    )


@app.post("/api/lender/topup", response_model=BalanceResponse, tags=["Wallet"])
async def lender_topup(payload: TopUpRequest):
    email = payload.email.strip().lower()
    _ensure_lender(email)
    LENDERS_DB[email]["idle_funds"] = round(LENDERS_DB[email]["idle_funds"] + payload.amount, 2)
    return BalanceResponse(email=email, balance=LENDERS_DB[email]["idle_funds"])


@app.get("/api/lender/idle", response_model=BalanceResponse, tags=["Wallet"])
async def lender_idle(email: str):
    email = email.strip().lower()
    _ensure_lender(email)
    return BalanceResponse(email=email, balance=LENDERS_DB[email]["idle_funds"])


@app.get("/api/borrower/balance", response_model=BalanceResponse, tags=["Wallet"])
async def borrower_balance(email: str):
    email = email.strip().lower()
    _ensure_borrower(email)
    return BalanceResponse(email=email, balance=BORROWERS_DB[email]["balance"])


@app.post("/api/borrower/withdraw", response_model=BalanceResponse, tags=["Wallet"])
async def borrower_withdraw(payload: WithdrawRequest):
    email = payload.email.strip().lower()
    _ensure_borrower(email)
    bal = BORROWERS_DB[email]["balance"]
    if payload.amount > bal:
        raise HTTPException(status_code=402,
                            detail=f"Saldo Anda ${bal:,.0f} tidak cukup untuk menarik ${payload.amount:,.0f}.")
    BORROWERS_DB[email]["balance"] = round(bal - payload.amount, 2)
    return BalanceResponse(email=email, balance=BORROWERS_DB[email]["balance"])


@app.post("/api/loans/pay/{loan_id}", response_model=LoanRecord, tags=["Repayment"])
async def pay_installment(loan_id: str):
    from datetime import timedelta

    for loan in LOANS_DB:
        if loan["loan_id"] == loan_id:
            if not loan["status"].startswith("Accepted"):
                raise HTTPException(status_code=409,
                                    detail="Pinjaman ini belum aktif atau sudah selesai.")
            if loan["paid_installments"] >= loan["total_installments"]:
                raise HTTPException(status_code=409,
                                    detail="Semua cicilan sudah lunas.")

            borrower_email = loan["borrower_email"]
            _ensure_borrower(borrower_email)
            balance = BORROWERS_DB[borrower_email]["balance"]
            installment = loan["monthly_installment"]

            if balance < installment:
                raise HTTPException(
                    status_code=402,
                    detail=(
                        f"Saldo SafeCredit Anda ${balance:,.2f} tidak cukup untuk membayar "
                        f"cicilan ${installment:,.2f}. Silakan tambah dana terlebih dahulu."
                    ),
                )

            BORROWERS_DB[borrower_email]["balance"] = round(balance - installment, 2)

            loan["paid_installments"] += 1
            loan["on_time_payments"] += 1
            paid = loan["paid_installments"]
            loan["success_rate"] = round(loan["on_time_payments"] / paid * 100, 1)

            if loan["paid_installments"] >= loan["total_installments"]:
                loan["status"] = "Accepted (Complete)"
                loan["next_payment_due"] = None
            else:
                loan["next_payment_due"] = (
                    datetime.now(timezone.utc) + timedelta(days=30)
                ).isoformat()

            return LoanRecord(**loan)

    raise HTTPException(status_code=404, detail=f"Pinjaman {loan_id} tidak ditemukan.")


ADMIN_TOKEN = "admin"


def _require_admin(token):
    if token != ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail="Akses ditolak. Hanya admin.")


@app.get("/api/admin/loans", response_model=List[LoanRecord], tags=["Admin"])
async def admin_list_all_loans(x_admin_token: str = Header("")):
    _require_admin(x_admin_token)
    return [LoanRecord(**l) for l in reversed(LOANS_DB)]


@app.delete("/api/admin/loans/{loan_id}", tags=["Admin"])
async def admin_delete_loan(loan_id: str, x_admin_token: str = Header("")):
    _require_admin(x_admin_token)
    for i, loan in enumerate(LOANS_DB):
        if loan["loan_id"] == loan_id:
            if loan.get("funded_by"):
                lender_email = loan["funded_by"]
                if lender_email in LENDERS_DB:
                    LENDERS_DB[lender_email]["idle_funds"] = round(
                        LENDERS_DB[lender_email]["idle_funds"] + loan["loan_amount"], 2)
            LOANS_DB.pop(i)
            return {"success": True, "message": f"Pinjaman {loan_id} dihapus.", "deleted_loan_id": loan_id}
    raise HTTPException(status_code=404, detail=f"Pinjaman {loan_id} tidak ditemukan.")


@app.get("/api/health", tags=["Health"])
async def health():
    return {"status": "ok", "meta": ARTIFACTS.get("model_meta", {})}

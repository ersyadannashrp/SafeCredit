
const BASE_URL = 'http://localhost:8000';

const session = { loggedIn: false, email: null, role: null, kycDone: false };

function saveSession() {
  sessionStorage.setItem('safecredit_session', JSON.stringify(session));
}
function loadSession() {
  const raw = sessionStorage.getItem('safecredit_session');
  if (raw) { try { Object.assign(session, JSON.parse(raw)); } catch {  } }
}

let lastAnalysis = null;

const $ = (id) => document.getElementById(id);
const views = document.querySelectorAll('.view');
const navItems = document.querySelectorAll('.nav-item');

const formatUSD = (n) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

function showToast(message, type = 'success') {
  const container = $('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<div style="flex:1">${message}</div>`;
  container.appendChild(toast);
  setTimeout(() => { toast.classList.add('fade-out'); setTimeout(() => toast.remove(), 300); }, 3200);
}

const PROTECTED_VIEWS = ['kyc', 'simulator', 'dashboard', 'wallet', 'active-loans', 'lender', 'topup', 'admin'];
const BORROWER_VIEWS = ['kyc', 'simulator', 'dashboard', 'wallet', 'active-loans'];
const LENDER_VIEWS = ['lender', 'topup'];

function navigateTo(viewId) {
  if (PROTECTED_VIEWS.includes(viewId) && !session.loggedIn) {
    showToast('Silakan masuk terlebih dahulu.', 'error');
    viewId = 'login';
  }
  if (session.loggedIn && session.role === 'admin' && viewId !== 'admin' && viewId !== 'login') {
    viewId = 'admin';
  }
  if (session.loggedIn && session.role === 'pendana'
      && BORROWER_VIEWS.concat('admin').includes(viewId)) viewId = 'lender';
  if (session.loggedIn && session.role === 'peminjam'
      && LENDER_VIEWS.concat('admin').includes(viewId)) viewId = 'dashboard';

  views.forEach((v) => v.classList.remove('active'));
  navItems.forEach((n) => n.classList.remove('active'));
  const tv = $(`view-${viewId}`);
  const tn = document.querySelector(`.nav-item[data-view="${viewId}"]`);
  if (tv) tv.classList.add('active');
  if (tn) tn.classList.add('active');

  if (viewId === 'login') {
    document.body.classList.add('logged-out');
    $('sidebarUser').style.display = 'none';
  } else {
    document.body.classList.remove('logged-out');
    $('sidebarUser').style.display = 'flex';
  }

  if (viewId === 'dashboard') fetchMyDashboard();
  if (viewId === 'wallet') fetchBorrowerWallet();
  if (viewId === 'active-loans') fetchActiveLoans();
  if (viewId === 'lender') { fetchMarketplace(); fetchPortfolioReal(); }
  if (viewId === 'topup') fetchTopupIdle();
  if (viewId === 'admin') fetchAdminLoans();
}

navItems.forEach((item) => {
  item.addEventListener('click', (e) => { e.preventDefault(); navigateTo(item.dataset.view); });
});

function applyRoleNav() {
  navItems.forEach((item) => { item.style.display = item.dataset.role === session.role ? 'flex' : 'none'; });
}

function applyProfileHeader() {
  $('userEmailDisplay').textContent = session.email;
  $('userRoleDisplay').textContent =
    session.role === 'admin' ? 'Administrator'
    : session.role === 'pendana' ? 'Pendana (Investor)'
    : 'Peminjam';
  $('userAvatar').textContent = (session.email[0] || 'U').toUpperCase();
}

$('goToRegisterLink')?.addEventListener('click', (e) => {
  e.preventDefault();
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  $('view-register').classList.add('active');
});
$('goToLoginLink')?.addEventListener('click', (e) => {
  e.preventDefault();
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  $('view-login').classList.add('active');
});

$('loginForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('loginEmail').value.trim();
  const pass = $('loginPass').value;
  const errBox = $('loginError');
  const btn = $('loginSubmitBtn');
  const spinner = btn.querySelector('.btn-spinner');

  if (!email || !pass) {
    errBox.style.display = 'block';
    errBox.textContent = 'Email dan password wajib diisi.';
    return;
  }
  errBox.style.display = 'none';
  btn.disabled = true; spinner.style.display = 'block';

  try {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pass }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Login gagal.');
    }
    const data = await res.json();

    session.loggedIn = true;
    session.email = data.email;
    session.role = data.role;
    session.kycDone = false;
    saveSession();

    applyProfileHeader();
    applyRoleNav();

    if (session.role === 'admin') {
      navigateTo('admin');
      showToast('Selamat datang, Administrator.', 'success');
    } else if (session.role === 'pendana') {
      navigateTo('lender');
      showToast(`Selamat datang, ${data.email}`, 'success');
    } else {
      navigateTo('kyc');
      showToast(`Selamat datang, ${data.email}. Silakan verifikasi identitas.`, 'success');
    }
  } catch (error) {
    errBox.style.display = 'block';
    errBox.textContent = error.message || 'Tidak dapat terhubung ke server.';
  } finally {
    btn.disabled = false; spinner.style.display = 'none';
  }
});

$('registerForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('regEmail').value.trim();
  const pass = $('regPass').value;
  const confirm = $('regPassConfirm').value;
  const roleEl = document.querySelector('input[name="regRole"]:checked');
  const errBox = $('registerError');
  const btn = $('registerSubmitBtn');
  const spinner = btn.querySelector('.btn-spinner');

  if (!roleEl) {
    errBox.style.display = 'block';
    errBox.textContent = 'Pilih peran Anda (Peminjam atau Pendana).';
    return;
  }
  if (!email || !pass) {
    errBox.style.display = 'block';
    errBox.textContent = 'Email dan password wajib diisi.';
    return;
  }
  if (pass !== confirm) {
    errBox.style.display = 'block';
    errBox.textContent = 'Konfirmasi password tidak sama.';
    return;
  }
  errBox.style.display = 'none';
  btn.disabled = true; spinner.style.display = 'block';

  try {
    const res = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pass, role: roleEl.value }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = Array.isArray(err.detail) ? err.detail[0]?.msg : err.detail;
      throw new Error(msg || 'Pendaftaran gagal.');
    }
    showToast('Pendaftaran berhasil! Silakan masuk dengan akun baru Anda.', 'success');
    $('regEmail').value = ''; $('regPass').value = ''; $('regPassConfirm').value = '';
    if (roleEl) roleEl.checked = false;
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    $('view-login').classList.add('active');
    $('loginEmail').value = email;
    $('loginPass').focus();
  } catch (error) {
    errBox.style.display = 'block';
    errBox.textContent = error.message || 'Tidak dapat terhubung ke server.';
  } finally {
    btn.disabled = false; spinner.style.display = 'none';
  }
});

$('eyeToggle')?.addEventListener('click', () => {
  const inp = $('loginPass'); inp.type = inp.type === 'password' ? 'text' : 'password';
});

$('logoutBtn')?.addEventListener('click', () => {
  session.loggedIn = false; session.email = null; session.role = null; session.kycDone = false;
  sessionStorage.removeItem('safecredit_session');
  navigateTo('login');
  showToast('Berhasil keluar.', 'success');
});

$('kycForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('kycSubmitBtn');
  const spinner = btn.querySelector('.btn-spinner');
  const text = btn.querySelector('.btn-text');
  const errBox = $('kycError');
  errBox.style.display = 'none';

  const payload = {
    email: session.email,
    full_name: $('kycNama').value.trim(),
    nik: $('kycNik').value.trim(),
    address: $('kycAlamat').value.trim(),
    rt_rw: $('kycRtRw').value.trim().replace(/\s/g, ''),
    kelurahan: $('kycKelurahan').value.trim(),
    kecamatan: $('kycKecamatan').value.trim(),
  };
  const required = ['full_name', 'nik', 'address', 'rt_rw', 'kelurahan', 'kecamatan'];
  if (required.some((k) => !payload[k])) { errBox.style.display = 'block'; errBox.textContent = 'Semua kolom wajib diisi.'; return; }
  if (!/^\d{16}$/.test(payload.nik)) { errBox.style.display = 'block'; errBox.textContent = 'NIK harus tepat 16 digit angka.'; return; }
  if (!/^\d{1,3}\/\d{1,3}$/.test(payload.rt_rw)) { errBox.style.display = 'block'; errBox.textContent = 'Format RT/RW tidak valid. Contoh: 003/007'; return; }

  btn.disabled = true; spinner.style.display = 'block'; text.textContent = 'Memverifikasi...';
  try {
    const res = await fetch(`${BASE_URL}/api/kyc/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.detail?.[0]?.msg || err.detail || 'Verifikasi gagal.'); }
    const data = await res.json();
    session.kycDone = true; saveSession();
    $('kycBadge').style.display = 'flex';
    $('kycProceedBox').style.display = 'block';
    $('kycProceedSub').textContent = `Halo ${payload.full_name}, identitas Anda tersimpan & terverifikasi.`;
    showToast('e-KYC berhasil diverifikasi.', 'success');
    $('kycProceedBox').scrollIntoView({ behavior: 'smooth', block: 'end' });
  } catch (error) {
    console.error(error); errBox.style.display = 'block'; errBox.textContent = error.message || 'Gagal terhubung ke server (uvicorn).';
  } finally {
    btn.disabled = false; spinner.style.display = 'none'; text.textContent = 'Verifikasi & Simpan';
  }
});

async function refreshKycStatus() {
  if (!session.email) return false;
  try {
    const res = await fetch(`${BASE_URL}/api/kyc/status?email=${encodeURIComponent(session.email)}`);
    if (!res.ok) return false;
    const data = await res.json();
    session.kycDone = data.verified; saveSession();
    if (data.verified) $('kycBadge').style.display = 'flex';
    return data.verified;
  } catch { return false; }
}

$('kycNik')?.addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 16);
  const len = e.target.value.length;
  $('kycNikHint').textContent = len === 16 ? '✓ 16 digit' : `${len}/16 digit`;
  $('kycNikHint').style.color = len === 16 ? 'var(--green-600)' : 'var(--text-muted)';
});

$('proceedToSimBtn')?.addEventListener('click', () => navigateTo('simulator'));

const loanSlider = $('loanSlider');
const sliderDisplay = $('sliderAmountDisplay');
const gaugeFill = $('gaugeFill');
const gaugeNeedle = $('gaugeNeedle');
const riskPctDisplay = $('riskPctDisplay');
const rvDot = $('rvDot');
const rvText = $('rvText');
const liveDot = $('liveDot');

function getLoanPayload() {
  return {
    annual_income: Number($('annualIncome').value) || 0,
    coapplicant_income: Number($('coapplicantIncome').value) || 0,
    other_monthly_debt: Number($('otherDebt').value) || 0,
    age: Number($('age').value) || 30,
    years_employment_experience: Number($('yearsExperience').value) || 0,
    credit_history_length: Number($('credHistLength').value) || 0,
    is_self_employed: $('isSelfEmployed').value || 'No',
    has_previous_default: $('hasPreviousDefault').value || 'No',
    home_ownership: $('homeOwnership').value || 'RENT',
    loan_amount: Number(loanSlider.value),
    tenor_months: Number($('tenorMonths').value) || 12,
    loan_intent: $('loanIntent') ? ($('loanIntent').value || 'PERSONAL') : 'PERSONAL',
  };
}

function updateGaugeUI(prob) {
  const c = Math.max(0, Math.min(1, prob));
  riskPctDisplay.textContent = `${(c * 100).toFixed(1)}%`;
  gaugeFill.style.strokeDashoffset = String(283 - c * 283);
  gaugeNeedle.setAttribute('transform', `rotate(${-90 + c * 180}, 110, 120)`);
  rvDot.className = 'rv-dot';
  if (c <= 0.30) { rvDot.classList.add('safe'); rvText.textContent = 'Risiko Rendah — Aman'; gaugeFill.style.stroke = 'var(--green-500)'; riskPctDisplay.style.color = 'var(--green-600)'; }
  else if (c <= 0.60) { rvDot.classList.add('warn'); rvText.textContent = 'Risiko Menengah'; gaugeFill.style.stroke = 'var(--amber)'; riskPctDisplay.style.color = 'var(--amber)'; }
  else { rvDot.classList.add('danger'); rvText.textContent = 'Risiko Tinggi — Potensi Gagal Bayar'; gaugeFill.style.stroke = 'var(--red)'; riskPctDisplay.style.color = 'var(--red)'; }
}

function renderFormulaFactors(data) {
  const list = $('xaiFactorList');
  $('xaiCard').style.display = 'block';
  const factors = [];

  const pdGood = data.pd_formula <= 0.20;
  factors.push({
    label: 'Probabilitas Gagal Bayar (Rumus)',
    good: pdGood,
    note: `${(data.pd_formula * 100).toFixed(1)}% ${pdGood ? '— rendah' : '— tinggi'}`,
    primary: true,
  });

  (data.top_factors || []).forEach((t) => {
    const good = t.direction === 'decreases risk';
    factors.push({
      label: t.label,
      good,
      note: `kontribusi ${t.contribution > 0 ? '+' : ''}${t.contribution.toFixed(2)} pada z ${good ? '— menurunkan risiko' : '— menaikkan risiko'}`,
    });
  });

  list.innerHTML = factors.map((f) => `
    <div class="xai-factor ${f.good ? 'good' : 'bad'} ${f.primary ? 'primary' : ''}">
      <span class="xai-dot"></span>
      <div class="xai-factor-body">
        <span class="xai-factor-label">${f.label}${f.primary ? ' <em>(faktor utama)</em>' : ''}</span>
        <span class="xai-factor-note">${f.note}</span>
      </div>
      <span class="xai-arrow">${f.good ? '↓' : '↑'}</span>
    </div>`).join('');
}

let debounceTimer;
function triggerSimulation() {
  liveDot.classList.remove('active'); liveDot.classList.add('loading');
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    try {
      const payload = getLoanPayload();
      const res = await fetch(`${BASE_URL}/api/loan/simulate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('simulate failed');
      const data = await res.json();
      updateGaugeUI(data.effective_risk);
      $('riskDetailsGrid').style.display = 'grid';
      $('rdgCredit').textContent = `${data.credit_score} (${data.score_band})`;
      $('rdgInstallment').textContent = formatUSD(data.monthly_installment);
      $('rdgFrontDti').textContent = `${(data.housing_expense_ratio * 100).toFixed(1)}%`;
      $('rdgFrontDti').style.color = data.housing_expense_pass ? 'var(--green-600)' : 'var(--red)';
      $('rdgBackDti').textContent = `${(data.total_debt_obligation_ratio * 100).toFixed(1)}%`;
      $('rdgBackDti').style.color = data.debt_obligation_pass ? 'var(--green-600)' : 'var(--red)';
      $('rdgPd').textContent = `${(data.pd_formula * 100).toFixed(1)}%`;
      $('rdgPd').style.color = data.pd_pass ? 'var(--green-600)' : 'var(--red)';
      $('rdgMlValidate').textContent = data.ml_agrees
        ? `Setuju (selisih ${(data.agreement_gap * 100).toFixed(1)}%)`
        : `Tidak setuju (${(data.agreement_gap * 100).toFixed(1)}%)`;
      $('rdgMlValidate').style.color = data.ml_agrees ? 'var(--green-600)' : 'var(--amber)';
      $('rdgStatus').textContent = data.is_safe ? 'Aman' : 'Berisiko';
      $('rdgStatus').style.color = data.is_safe ? 'var(--green-600)' : 'var(--red)';
      renderFormulaFactors(data);
    } catch (error) {
      console.error('Backend offline', error);
      showToast('Gagal menyambung ke server (uvicorn offline).', 'error');
    } finally {
      liveDot.classList.remove('loading'); liveDot.classList.add('active');
    }
  }, 350);
}

if (loanSlider) {
  loanSlider.addEventListener('input', (e) => {
    sliderDisplay.textContent = Number(e.target.value).toLocaleString('en-US');
    triggerSimulation();
  });
}
['annualIncome', 'coapplicantIncome', 'otherDebt', 'age',
 'yearsExperience', 'credHistLength', 'homeOwnership', 'isSelfEmployed',
 'hasPreviousDefault', 'tenorMonths', 'loanIntent']
  .forEach((id) => $(id)?.addEventListener('change', triggerSimulation));

$('loanForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('applyBtn');
  const spinner = btn.querySelector('.btn-spinner');
  const errBox = $('loanFormError');
  errBox.style.display = 'none';

  const verified = await refreshKycStatus();
  if (!verified) {
    errBox.style.display = 'block';
    errBox.textContent = 'Anda harus menyelesaikan verifikasi KYC terlebih dahulu sebelum mengajukan pinjaman.';
    showToast('Verifikasi KYC diperlukan.', 'error');
    setTimeout(() => navigateTo('kyc'), 1200);
    return;
  }

  const payload = getLoanPayload();
  if (!$('homeOwnership').value || !$('isSelfEmployed').value || !$('hasPreviousDefault').value) {
    errBox.style.display = 'block'; errBox.textContent = 'Lengkapi semua pilihan (kepemilikan rumah, status pekerjaan, riwayat).'; return;
  }

  btn.disabled = true; spinner.style.display = 'block';
  try {
    const res = await fetch(`${BASE_URL}/api/loan/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('analyze failed');
    const data = await res.json();
    lastAnalysis = { data, payload };
    renderFormulaFactors(data.assessment);

    if (data.is_requested_safe) {
      await submitLoanToDB(data, payload, payload.loan_amount, false);
    } else {
      openRestructureModal(data, payload);
    }
  } catch (error) {
    console.error(error); errBox.style.display = 'block'; errBox.textContent = 'Terjadi kesalahan. Pastikan backend uvicorn menyala.';
  } finally {
    btn.disabled = false; spinner.style.display = 'none';
  }
});

function openRestructureModal(data, payload) {
  const isUnfundable = data.application_status === 'UNFUNDABLE';
  $('modalTitle').textContent = isUnfundable ? 'Pinjaman Sulit Didanai' : 'Pinjaman Berisiko Tinggi';
  $('modalDesc').innerHTML = isUnfundable
    ? `Profil risiko Anda tinggi. Jumlah aman terendah yang kami temukan adalah <strong>${formatUSD(data.recommended_amount)}</strong>. Anda tetap dapat memaksakan jumlah asli, namun peluang didanai sangat kecil.`
    : `Pinjaman Anda berisiko tinggi (PD <strong>${(data.assessment.pd_formula * 100).toFixed(1)}%</strong>, rasio cicilan <strong>${(data.assessment.total_debt_obligation_ratio * 100).toFixed(1)}%</strong>). Sistem merekomendasikan penyesuaian menjadi <strong>${formatUSD(data.recommended_amount)}</strong> agar memenuhi aturan 28/36 dan lebih mungkin didanai.`;
  $('modalOriginalAmount').textContent = formatUSD(data.requested_loan_amount);
  $('modalOriginalMeta').textContent = `Cicilan ${formatUSD(data.assessment.monthly_installment)}/bln · DTI ${(data.assessment.total_debt_obligation_ratio * 100).toFixed(1)}%`;
  $('modalRecAmount').textContent = formatUSD(data.recommended_amount);
  $('modalRecMeta').textContent = `Cicilan ${formatUSD(data.recommended_installment)}/bln · DTI ${(data.recommended_total_debt_ratio * 100).toFixed(1)}%`;
  $('modalAcceptAmount').textContent = formatUSD(data.recommended_amount);
  $('modalKeepAmount').textContent = formatUSD(data.requested_loan_amount);
  $('restructureModal').style.display = 'flex';
}
function closeModal() { $('restructureModal').style.display = 'none'; }

$('modalAcceptBtn')?.addEventListener('click', async () => {
  if (!lastAnalysis) return closeModal();
  const { data, payload } = lastAnalysis; closeModal();
  await submitLoanToDB(data, payload, data.recommended_amount, false);
});
$('modalKeepBtn')?.addEventListener('click', async () => {
  if (!lastAnalysis) return closeModal();
  const { data, payload } = lastAnalysis; closeModal();
  await submitLoanToDB(data, payload, data.requested_loan_amount, true);
});
$('modalCancelBtn')?.addEventListener('click', closeModal);
$('restructureModal')?.addEventListener('click', (e) => { if (e.target.id === 'restructureModal') closeModal(); });

async function submitLoanToDB(data, payload, chosenAmount, forced) {
  const a = data.assessment;
  let installment = a.monthly_installment;
  let rate = a.annual_interest_rate;
  let pdefault = a.pd_formula;
  let dti = a.total_debt_obligation_ratio;
  let score = a.credit_score;
  let mlAgrees = a.ml_agrees;
  let riskLabel = data.is_requested_safe ? 'LOW RISK' : 'HIGH RISK';
  let topFactor = a.top_factors && a.top_factors[0] ? a.top_factors[0].label : 'Rasio Cicilan (DTI)';
  let direction = a.top_factors && a.top_factors[0] ? a.top_factors[0].direction : 'increases risk';

  if (chosenAmount !== payload.loan_amount) {
    try {
      const simRes = await fetch(`${BASE_URL}/api/loan/simulate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, loan_amount: chosenAmount }),
      });
      if (simRes.ok) {
        const s = await simRes.json();
        installment = s.monthly_installment; rate = s.annual_interest_rate; pdefault = s.pd_formula; dti = s.total_debt_obligation_ratio;
        score = s.credit_score; mlAgrees = s.ml_agrees; riskLabel = s.risk_label;
        if (s.top_factors && s.top_factors[0]) { topFactor = s.top_factors[0].label; direction = s.top_factors[0].direction; }
      }
    } catch {  }
  }

  const body = {
    borrower_email: session.email,
    loan_amount: chosenAmount,
    tenor_months: payload.tenor_months,
    monthly_installment: installment,
    annual_interest_rate: rate,
    probability_of_default: pdefault,
    dti_ratio: dti,
    generated_credit_score: score,
    top_feature_label: topFactor,
    direction: direction,
    risk_label: riskLabel,
    ml_agrees: mlAgrees,
    forced_high_risk: forced,
  };

  try {
    const res = await fetch(`${BASE_URL}/api/loans/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('create loan failed');
    renderDecision(data, chosenAmount, forced, { installment, pdefault, dti, score, topFactor, direction });
    navigateTo('dashboard');
    $('dashBadge').style.display = 'flex';
    showToast(forced ? 'Pengajuan berisiko tinggi terkirim ke marketplace.' : 'Pengajuan terkirim! Menunggu pendana.', 'success');
  } catch (error) {
    console.error(error); showToast('Gagal menyimpan pengajuan ke server.', 'error');
  }
}

function renderDecision(data, chosenAmount, forced, fig) {
  $('dashResultContent').style.display = 'flex';
  const badge = $('shcBadge');
  const wasRestructured = chosenAmount < data.requested_loan_amount;
  if (forced) { badge.textContent = 'BERISIKO TINGGI'; badge.className = 'shc-badge rejected'; }
  else if (wasRestructured) { badge.textContent = 'DIRESTRUKTURISASI'; badge.className = 'shc-badge restructured'; }
  else { badge.textContent = 'DIAJUKAN'; badge.className = 'shc-badge'; }

  if (wasRestructured) {
    $('originalAmountBlock').style.display = 'flex';
    $('requestedAmountDisplay').textContent = formatUSD(data.requested_loan_amount);
    $('restructureAlert').style.display = 'flex';
    $('raOriginal').textContent = formatUSD(data.requested_loan_amount);
    $('raApproved').textContent = formatUSD(chosenAmount);
  } else {
    $('originalAmountBlock').style.display = 'none';
    $('restructureAlert').style.display = 'none';
  }

  $('approvedAmountDisplay').textContent = formatUSD(chosenAmount);
  $('shcInstallment').textContent = formatUSD(fig.installment);
  $('dmcPDefault').textContent = `${(fig.pdefault * 100).toFixed(1)}%`;
  $('dmcCredit').textContent = fig.score;
  $('dmcDti').textContent = `${(fig.dti * 100).toFixed(1)}%`;
  $('dmcFeature').textContent = fig.topFactor;

  const dir = fig.direction;
  $('sicFeatureName').textContent = fig.topFactor;
  $('sicShapVal').textContent = '(rumus logistik)';
  const dirBadge = $('sicDirection'); const fillBar = $('sicBarFill');
  if (dir === 'increases risk') {
    dirBadge.textContent = '↑ Meningkatkan Risiko'; dirBadge.className = 'sic-direction increases';
    fillBar.style.width = '75%'; fillBar.style.background = 'var(--red)';
  } else {
    dirBadge.textContent = '↓ Menurunkan Risiko'; dirBadge.className = 'sic-direction decreases';
    fillBar.style.width = '25%'; fillBar.style.background = 'var(--green-500)';
  }
  $('lncText').textContent = data.llm_narrative || 'Penjelasan AI tidak tersedia.';
}

$('newLoanFromDashBtn')?.addEventListener('click', () => navigateTo('simulator'));

function statusChipClass(status) {
  if (status.startsWith('Accepted')) return status.includes('Complete') ? 'complete' : 'lancar';
  if (status === 'Pending') return 'pending';
  return 'late';
}

async function fetchMyDashboard() {
  if (!session.email) return;
  const tbody = $('borrowerLoanTbody');
  try {
    const res = await fetch(`${BASE_URL}/api/loans/my-dashboard?email=${encodeURIComponent(session.email)}`);
    if (!res.ok) throw new Error('dashboard fetch failed');
    const loans = await res.json();
    $('borrowerLoanCount').textContent = `${loans.length} pengajuan`;
    if (loans.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-faint);padding:32px">Belum ada pengajuan. Buat pengajuan baru di Simulator.</td></tr>`;
      return;
    }
    tbody.innerHTML = loans.map((l) => `
      <tr>
        <td class="mono">${l.loan_id}</td>
        <td>${formatUSD(l.loan_amount)}${l.forced_high_risk ? ' <span class="risk-flag" title="Diajukan meski berisiko tinggi">⚠</span>' : ''}</td>
        <td>${l.tenor_months} bln</td>
        <td>${formatUSD(l.monthly_installment)}</td>
        <td>${(l.probability_of_default * 100).toFixed(1)}%</td>
        <td><span class="status-chip ${statusChipClass(l.status)}">${l.status}</span></td>
        <td>${new Date(l.created_at).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
      </tr>`).join('');
  } catch (error) {
    console.error(error);
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--red);padding:24px">Gagal memuat data dari server.</td></tr>`;
  }
}

async function fetchMarketplace() {
  const grid = $('marketplaceGrid');
  try {
    const res = await fetch(`${BASE_URL}/api/loans/marketplace`);
    if (!res.ok) throw new Error('marketplace fetch failed');
    const loans = await res.json();
    if (loans.length === 0) {
      grid.innerHTML = `<div class="market-empty">Belum ada pengajuan yang menunggu pendanaan.<br/><small>Pengajuan dari peminjam akan muncul di sini secara real-time.</small></div>`;
      return;
    }
    grid.innerHTML = loans.map((m) => {
      const p = m.probability_of_default;
      const riskClass = p <= 0.20 ? 'low' : p <= 0.30 ? 'medium' : 'high';
      const xaiGood = m.direction === 'decreases risk';
      const xaiText = m.forced_high_risk
        ? `Peminjam memaksakan jumlah berisiko tinggi. Faktor utama: ${m.top_feature_label} (${xaiGood ? 'menurunkan' : 'meningkatkan'} risiko).`
        : `${m.risk_label === 'LOW RISK' ? 'Aman didanai' : 'Perlu kehati-hatian'} — faktor utama: ${m.top_feature_label} (${xaiGood ? 'menurunkan' : 'meningkatkan'} risiko). DTI ${(m.dti_ratio * 100).toFixed(0)}%.`;
      return `
        <div class="market-card">
          <div class="market-card-top">
            <span class="mono market-id">${m.loan_id}</span>
            <span class="risk-chip ${riskClass}">P(def) ${(p * 100).toFixed(0)}%</span>
          </div>
          <div class="market-borrower">${m.borrower_email}</div>
          <div class="market-amount">${formatUSD(m.loan_amount)}</div>
          <div class="market-meta">
            <span>Tenor ${m.tenor_months} bln</span><span>·</span>
            <span>Cicilan ${formatUSD(m.monthly_installment)}</span><span>·</span>
            <span>Bunga ${(m.annual_interest_rate * 100).toFixed(2)}%</span>
          </div>
          <div class="market-meta">
            <span>DTI ${(m.dti_ratio * 100).toFixed(0)}%</span><span>·</span>
            <span>Skor ${m.generated_credit_score}</span><span>·</span>
            <span class="market-success">Sukses bayar ${m.success_rate}%</span>
          </div>
          <div class="market-xai ${xaiGood ? '' : 'warn'}">
            <span class="xai-tag">XAI</span><span>${xaiText}</span>
          </div>
          <button class="btn-primary w-full market-fund-btn" data-id="${m.loan_id}">Danai / Terima</button>
        </div>`;
    }).join('');

    grid.querySelectorAll('.market-fund-btn').forEach((b) => {
      b.addEventListener('click', async () => {
        b.disabled = true; b.textContent = 'Memproses...';
        try {
          const res = await fetch(`${BASE_URL}/api/loans/fund/${b.dataset.id}?lender_email=${encodeURIComponent(session.email)}`, { method: 'POST' });
          if (!res.ok) {
            const err = await res.json().catch(()=>({}));
            throw new Error(err.detail || 'fund failed');
          }
          showToast(`Pinjaman ${b.dataset.id} berhasil didanai.`, 'success');
          fetchMarketplace();
          fetchPortfolioReal();
        } catch (error) {
          console.error(error);
          showToast(error.message || 'Gagal mendanai pinjaman.', 'error');
          b.disabled = false; b.textContent = 'Danai / Terima';
        }
      });
    });
  } catch (error) {
    console.error(error);
    grid.innerHTML = `<div class="market-empty" style="color:var(--red)">Gagal memuat marketplace dari server.</div>`;
  }
}

async function fetchPortfolioReal() {
  if (!session.email) return;
  try {
    const res = await fetch(`${BASE_URL}/api/loans/my-portfolio?lender_email=${encodeURIComponent(session.email)}`);
    if (!res.ok) throw new Error('portfolio fetch failed');
    const data = await res.json();

    $('kpiInvested').textContent = formatUSD(data.total_invested);
    $('kpiInvestedSub').textContent = data.total_invested > 0 ? 'Modal aktif' : 'Belum ada investasi';
    $('kpiBorrowers').textContent = data.borrower_count;
    $('kpiLoansCount').textContent = `${data.loans_count} pinjaman`;
    $('kpiROI').textContent = data.projected_roi_percent > 0 ? `${data.projected_roi_percent.toFixed(1)}%` : '—';
    $('kpiInterest').textContent = data.total_interest_projected > 0
      ? `+${formatUSD(data.total_interest_projected)} proyeksi bunga`
      : '—';
    $('kpiIdle').textContent = formatUSD(data.idle_funds);

    const tbody = $('portfolioTbody');
    $('portfolioCount').textContent = `${data.loans_count} pinjaman`;
    if (data.loans_count === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-faint);padding:32px">Belum ada pinjaman yang Anda danai. Danai dari tab Marketplace.</td></tr>`;
      return;
    }
    tbody.innerHTML = data.funded_loans.map((p) => {
      const due = new Date(p.created_at);
      due.setMonth(due.getMonth() + p.tenor_months);
      const dueStr = due.toLocaleDateString('id-ID', { month: 'short', year: 'numeric' });
      const stClass = p.status.includes('Complete') ? 'complete' : 'lancar';
      return `
      <tr>
        <td class="mono">${p.loan_id}</td>
        <td>${formatUSD(p.loan_amount)}</td>
        <td>${(p.annual_interest_rate * 100).toFixed(2)}%</td>
        <td>${p.tenor_months} bln</td>
        <td><span class="risk-chip ${p.probability_of_default <= 0.2 ? 'low' : p.probability_of_default <= 0.3 ? 'medium' : 'high'}">${(p.probability_of_default * 100).toFixed(0)}%</span></td>
        <td><span class="status-chip ${stClass}">${p.status}</span></td>
        <td>${p.success_rate}%</td>
      </tr>`;
    }).join('');
  } catch (error) {
    console.error('portfolio fetch failed', error);
  }
}

document.querySelectorAll('.lender-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.lender-tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.lender-tab-content').forEach((c) => c.classList.remove('active'));
    tab.classList.add('active');
    $(`tab-${tab.dataset.tab}`).classList.add('active');
    if (tab.dataset.tab === 'portfolio') fetchPortfolioReal();
  });
});

async function fetchAdminLoans() {
  if (session.role !== 'admin') return;
  const tbody = $('adminLoansTbody');
  try {
    const res = await fetch(`${BASE_URL}/api/admin/loans`, {
      headers: { 'X-Admin-Token': 'admin' },
    });
    if (!res.ok) throw new Error('admin fetch failed');
    const loans = await res.json();

    $('adminTotalLoans').textContent = loans.length;
    $('adminPendingLoans').textContent = loans.filter((l) => l.status === 'Pending').length;
    $('adminActiveLoans').textContent = loans.filter((l) => l.status.startsWith('Accepted')).length;
    $('adminUniqueBorrowers').textContent = new Set(loans.map((l) => l.borrower_email)).size;
    $('adminLoanCount').textContent = `${loans.length} pinjaman`;

    if (loans.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--text-faint);padding:32px">Belum ada pinjaman di sistem.</td></tr>`;
      return;
    }
    tbody.innerHTML = loans.map((l) => {
      const statusClass = l.status.startsWith('Accepted') ? 'lancar'
        : l.status === 'Pending' ? 'pending' : 'late';
      const riskClass = l.probability_of_default <= 0.2 ? 'low'
        : l.probability_of_default <= 0.3 ? 'medium' : 'high';
      return `
      <tr>
        <td class="mono">${l.loan_id}</td>
        <td class="small-text">${l.borrower_email}</td>
        <td>${formatUSD(l.loan_amount)}</td>
        <td>${l.tenor_months} bln</td>
        <td>${formatUSD(l.monthly_installment)}</td>
        <td><span class="risk-chip ${riskClass}">${(l.probability_of_default * 100).toFixed(0)}%</span></td>
        <td><span class="status-chip ${statusClass}">${l.status}</span></td>
        <td class="small-text">${l.funded_by || '—'}</td>
        <td><button class="btn-danger-sm admin-delete-btn" data-id="${l.loan_id}">Hapus</button></td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('.admin-delete-btn').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm(`Yakin hapus pinjaman ${b.dataset.id}? Jika sudah didanai, dana akan dikembalikan ke pendana.`)) return;
        b.disabled = true; b.textContent = '...';
        try {
          const r = await fetch(`${BASE_URL}/api/admin/loans/${b.dataset.id}`, {
            method: 'DELETE',
            headers: { 'X-Admin-Token': 'admin' },
          });
          if (!r.ok) throw new Error('delete failed');
          showToast(`Pinjaman ${b.dataset.id} dihapus.`, 'success');
          fetchAdminLoans();
        } catch (error) {
          console.error(error); showToast('Gagal menghapus pinjaman.', 'error');
          b.disabled = false; b.textContent = 'Hapus';
        }
      });
    });
  } catch (error) {
    console.error(error);
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--red);padding:24px">Gagal memuat data admin.</td></tr>`;
  }
}

$('adminRefreshBtn')?.addEventListener('click', fetchAdminLoans);

async function fetchBorrowerWallet() {
  if (!session.email) return;
  try {
    const res = await fetch(`${BASE_URL}/api/borrower/balance?email=${encodeURIComponent(session.email)}`);
    if (!res.ok) throw new Error('balance fetch failed');
    const data = await res.json();
    if ($('walletBalance')) $('walletBalance').textContent = formatUSD(data.balance);
    if ($('withdrawAvailable')) $('withdrawAvailable').textContent = formatUSD(data.balance);
  } catch (error) { console.error(error); }
}

$('withdrawForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const amount = Number($('withdrawAmount').value);
  const dest = $('withdrawDest').value;
  const acct = $('withdrawAccount').value.trim();
  const errBox = $('withdrawError'); errBox.style.display = 'none';
  if (!amount || amount <= 0) { errBox.style.display = 'block'; errBox.textContent = 'Masukkan nominal yang valid.'; return; }
  if (!acct) { errBox.style.display = 'block'; errBox.textContent = 'Masukkan nomor rekening / e-wallet tujuan.'; return; }
  const btn = $('withdrawBtn'); btn.disabled = true;
  try {
    const res = await fetch(`${BASE_URL}/api/borrower/withdraw`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: session.email, amount, destination: dest }),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.detail || 'Penarikan gagal.'); }
    const data = await res.json();
    showToast(`Berhasil menarik ${formatUSD(amount)} ke ${dest}.`, 'success');
    $('withdrawAmount').value = ''; $('withdrawAccount').value = '';
    if ($('walletBalance')) $('walletBalance').textContent = formatUSD(data.balance);
    if ($('withdrawAvailable')) $('withdrawAvailable').textContent = formatUSD(data.balance);
  } catch (error) {
    errBox.style.display = 'block'; errBox.textContent = error.message;
  } finally { btn.disabled = false; }
});

async function fetchActiveLoans() {
  if (!session.email) return;
  const wrap = $('activeLoansList');
  if (!wrap) return;
  try {
    const res = await fetch(`${BASE_URL}/api/loans/my-dashboard?email=${encodeURIComponent(session.email)}`);
    if (!res.ok) throw new Error('active loans fetch failed');
    const loans = (await res.json()).filter((l) => l.status.startsWith('Accepted'));
    if (loans.length === 0) {
      wrap.innerHTML = `<div class="market-empty">Belum ada pinjaman aktif. Pinjaman yang sudah didanai pendana akan muncul di sini.</div>`;
      return;
    }
    wrap.innerHTML = loans.map((l) => {
      const complete = l.status.includes('Complete');
      const pct = Math.round((l.paid_installments / l.total_installments) * 100);

      let deadlineHtml = '';
      if (!complete && l.next_payment_due) {
        const due = new Date(l.next_payment_due);
        const now = new Date();
        const diffMs = due - now;
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        const diffHrs  = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
        const isOverdue = diffMs < 0;

        if (isOverdue) {
          deadlineHtml = `<div class="alc-deadline overdue">
            ⚠ Cicilan Telah Jatuh Tempo — Segera Bayar
          </div>`;
        } else if (diffDays <= 3) {
          deadlineHtml = `<div class="alc-deadline urgent">
            ⏰ Jatuh tempo dalam ${diffDays}h ${diffHrs}j ${diffMins}m
          </div>`;
        } else {
          deadlineHtml = `<div class="alc-deadline safe">
            📅 Jatuh tempo: ${due.toLocaleDateString('id-ID', {day:'numeric',month:'long',year:'numeric'})}
            <span class="alc-deadline-days">(${diffDays} hari lagi)</span>
          </div>`;
        }
      }

      return `
        <div class="active-loan-card">
          <div class="alc-top">
            <span class="mono">${l.loan_id}</span>
            <span class="status-chip ${complete ? 'complete' : 'lancar'}">${l.status}</span>
          </div>
          <div class="alc-amount">${formatUSD(l.loan_amount)} <span class="alc-rate">· bunga ${(l.annual_interest_rate * 100).toFixed(2)}%/thn</span></div>
          <div class="alc-meta">Cicilan ${formatUSD(l.monthly_installment)}/bln · ${l.paid_installments}/${l.total_installments} terbayar</div>
          <div class="alc-progress"><div class="alc-progress-fill" style="width:${pct}%"></div></div>
          <div class="alc-stats">
            <span>Tepat waktu: ${l.on_time_payments}</span>
            <span>Telat: ${l.late_payments}</span>
            <span class="alc-success">Sukses: ${l.success_rate}%</span>
          </div>
          ${deadlineHtml}
          ${complete ? `<div class="alc-done">✓ Pinjaman Lunas</div>` : `
          <div class="alc-actions">
            <button class="btn-primary alc-pay-btn" data-id="${l.loan_id}">
              Bayar Cicilan — ${formatUSD(l.monthly_installment)}
            </button>
          </div>`}
        </div>`;
    }).join('');

    const pay = async (loanId) => {
      const btn = wrap.querySelector(`.alc-pay-btn[data-id="${loanId}"]`);
      if (btn) { btn.disabled = true; btn.textContent = 'Memproses...'; }
      try {
        const res = await fetch(`${BASE_URL}/api/loans/pay/${loanId}`, { method: 'POST' });
        if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.detail || 'Pembayaran gagal.'); }
        const l = await res.json();
        if (l.status.includes('Complete')) showToast('Selamat! Pinjaman Anda lunas.', 'success');
        else showToast(`Cicilan ke-${l.paid_installments} berhasil dibayar. Jatuh tempo berikutnya sudah diperbarui.`, 'success');
        fetchActiveLoans();
      } catch (error) {
        showToast(error.message, 'error');
        fetchActiveLoans();
      }
    };
    wrap.querySelectorAll('.alc-pay-btn').forEach((b) => b.addEventListener('click', () => pay(b.dataset.id)));
  } catch (error) {
    console.error(error);
    wrap.innerHTML = `<div class="market-empty" style="color:var(--red)">Gagal memuat pinjaman aktif.</div>`;
  }
}

$('topupForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const amount = Number($('topupAmount').value);
  const source = $('topupSource').value;
  const acct = $('topupAccount').value.trim();
  const errBox = $('topupError'); errBox.style.display = 'none';
  if (!amount || amount <= 0) { errBox.style.display = 'block'; errBox.textContent = 'Masukkan nominal yang valid.'; return; }
  if (!acct) { errBox.style.display = 'block'; errBox.textContent = 'Masukkan nomor rekening / e-wallet sumber.'; return; }
  const btn = $('topupBtn'); btn.disabled = true;
  try {
    const res = await fetch(`${BASE_URL}/api/lender/topup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: session.email, amount, source }),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.detail || 'Top-up gagal.'); }
    const data = await res.json();
    showToast(`Berhasil top-up ${formatUSD(amount)}. Dana menganggur kini ${formatUSD(data.balance)}.`, 'success');
    $('topupAmount').value = ''; $('topupAccount').value = '';
    if ($('topupCurrentIdle')) $('topupCurrentIdle').textContent = formatUSD(data.balance);
    fetchPortfolioReal();
  } catch (error) {
    errBox.style.display = 'block'; errBox.textContent = error.message;
  } finally { btn.disabled = false; }
});

async function fetchTopupIdle() {
  if (!session.email) return;
  try {
    const res = await fetch(`${BASE_URL}/api/lender/idle?email=${encodeURIComponent(session.email)}`);
    if (!res.ok) return;
    const data = await res.json();
    if ($('topupCurrentIdle')) $('topupCurrentIdle').textContent = formatUSD(data.balance);
  } catch {  }
}

loadSession();
if (session.loggedIn && session.email) {
  applyProfileHeader();
  applyRoleNav();
  if (session.role === 'peminjam') refreshKycStatus();
  navigateTo(
    session.role === 'admin' ? 'admin'
    : session.role === 'pendana' ? 'lender'
    : 'dashboard'
  );
} else {
  navigateTo('login');
}

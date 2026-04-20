const state = {
  config: null,
  borrower: {
    user: null,
    application: null,
    currentStep: 1,
    selfieImage: ""
  },
  admin: {
    loggedIn: false,
    applications: []
  },
  mediaStream: null,
  trackingReference: "",
  trackingTimer: null
};

const els = {
  authPanel: document.querySelector("#auth-panel"),
  authMessage: document.querySelector("#auth-message"),
  borrowerApp: document.querySelector("#borrower-app"),
  borrowerLogout: document.querySelector("#borrower-logout"),
  borrowerAvatar: document.querySelector("#borrower-avatar"),
  borrowerName: document.querySelector("#borrower-name"),
  borrowerEmail: document.querySelector("#borrower-email"),
  resumeNote: document.querySelector("#resume-note"),
  statusBadge: document.querySelector("#borrower-status-badge"),
  referenceNumber: document.querySelector("#reference-number"),
  lastSavedAt: document.querySelector("#last-saved-at"),
  ageValidation: document.querySelector("#age-validation"),
  eligibilityCard: document.querySelector("#eligibility-card"),
  step1Form: document.querySelector("#step-1-form"),
  step2Panel: document.querySelector("#step-2-panel"),
  step3Form: document.querySelector("#step-3-form"),
  quickEligibilityForm: document.querySelector("#quick-eligibility-form"),
  quickEligibilityResult: document.querySelector("#quick-eligibility-result"),
  trackingForm: document.querySelector("#tracking-form"),
  trackingResult: document.querySelector("#tracking-result"),
  video: document.querySelector("#selfie-video"),
  canvas: document.querySelector("#selfie-canvas"),
  selfiePreview: document.querySelector("#selfie-preview"),
  startCamera: document.querySelector("#start-camera"),
  captureSelfie: document.querySelector("#capture-selfie"),
  adminAuthPanel: document.querySelector("#admin-auth-panel"),
  adminDashboard: document.querySelector("#admin-dashboard"),
  adminLoginForm: document.querySelector("#admin-login-form"),
  adminAuthMessage: document.querySelector("#admin-auth-message"),
  adminSearch: document.querySelector("#admin-search"),
  adminList: document.querySelector("#admin-list"),
  adminLogout: document.querySelector("#admin-logout")
};

init();

async function init() {
  bindScrollButtons();
  bindQuickTools();
  bindBorrowerForms();
  bindAdmin();

  state.config = await api("/api/config");
  await restoreBorrower();
  await restoreAdmin();
  initGoogleLogin();
}

function bindScrollButtons() {
  document.querySelectorAll("[data-scroll]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = document.querySelector(button.dataset.scroll);
      target?.scrollIntoView({ behavior: "smooth" });
    });
  });
}

function bindQuickTools() {
  els.quickEligibilityForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const eligibility = calculateEligibility({
      dateOfBirth: form.get("dateOfBirth"),
      employmentType: form.get("employmentType"),
      monthlySalary: Number(form.get("monthlySalary") || 0)
    });
    els.quickEligibilityResult.innerHTML = renderEligibilityHtml(eligibility);
    els.quickEligibilityResult.classList.remove("muted");
  });

  els.trackingForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const reference = String(new FormData(event.currentTarget).get("reference") || "").trim().toUpperCase();
    try {
      state.trackingReference = reference;
      await refreshTracking();
      if (state.trackingTimer) {
        clearInterval(state.trackingTimer);
      }
      state.trackingTimer = window.setInterval(refreshTracking, 5000);
    } catch (error) {
      els.trackingResult.textContent = error.message;
      els.trackingResult.classList.remove("muted");
    }
  });
}

function bindBorrowerForms() {
  els.step1Form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const personal = formToObject(event.currentTarget);
    personal.monthlySalary = Number(personal.monthlySalary || 0);
    const age = calculateAge(personal.dateOfBirth);
    if (age < 18) {
      els.ageValidation.textContent = "Applicant must be at least 18 years old.";
      return;
    }
    els.ageValidation.textContent = `Age verified: ${age} years.`;
    const application = await saveApplication({ personal, lastCompletedStep: 1 });
    hydrateBorrowerApplication(application, 2);
  });

  els.step1Form.dateOfBirth?.addEventListener("change", () => {
    const age = calculateAge(els.step1Form.dateOfBirth.value);
    els.ageValidation.textContent = age >= 18 ? `Age verified: ${age} years.` : "Applicant must be at least 18 years old.";
  });

  document.querySelector("#back-to-step-1").addEventListener("click", () => setBorrowerStep(1));
  document.querySelector("#continue-to-step-3").addEventListener("click", () => setBorrowerStep(3));
  document.querySelector("#back-to-step-2").addEventListener("click", () => setBorrowerStep(2));

  els.startCamera.addEventListener("click", startCamera);
  els.captureSelfie.addEventListener("click", captureSelfie);

  els.step3Form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.borrower.selfieImage && !state.borrower.application?.bank?.selfieImage) {
      alert("Capture a live selfie before submitting.");
      return;
    }

    const bank = formToObject(event.currentTarget);
    bank.eMandateConsent = Boolean(els.step3Form.eMandateConsent.checked);
    bank.selfieImage = state.borrower.selfieImage || state.borrower.application?.bank?.selfieImage || "";

    try {
      const response = await api("/api/application/submit", {
        method: "POST",
        body: JSON.stringify({ bank, lastCompletedStep: 3 })
      });
      hydrateBorrowerApplication(response.application, 3);
      stopCamera();
      alert(`Application submitted successfully. Reference number: ${response.application.referenceNumber}`);
    } catch (error) {
      alert(error.message);
    }
  });

  els.borrowerLogout.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    stopCamera();
    state.borrower = { user: null, application: null, currentStep: 1, selfieImage: "" };
    renderBorrower();
  });
}

function bindAdmin() {
  els.adminLoginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = formToObject(event.currentTarget);
    try {
      await api("/api/admin/login", { method: "POST", body: JSON.stringify(body) });
      els.adminAuthMessage.textContent = "";
      event.currentTarget.reset();
      await restoreAdmin();
    } catch (error) {
      els.adminAuthMessage.textContent = error.message;
    }
  });

  els.adminSearch.addEventListener("input", () => {
    loadAdminApplications(els.adminSearch.value.trim());
  });

  els.adminLogout.addEventListener("click", async () => {
    await api("/api/admin/logout", { method: "POST" });
    state.admin.loggedIn = false;
    state.admin.applications = [];
    renderAdmin();
  });
}

async function restoreBorrower() {
  try {
    const data = await api("/api/me");
    state.borrower.user = data.user;
    state.borrower.application = data.application;
    state.borrower.currentStep = deriveStep(data.application);
    renderBorrower();
    subscribeBorrower();
  } catch {
    renderBorrower();
  }
}

async function restoreAdmin() {
  try {
    await api("/api/admin/me");
    state.admin.loggedIn = true;
    renderAdmin();
    await loadAdminApplications("");
    subscribeAdmin();
  } catch {
    state.admin.loggedIn = false;
    renderAdmin();
  }
}

function initGoogleLogin() {
  if (!window.google || !state.config.googleClientId) {
    els.authMessage.textContent = state.config.googleClientId
      ? "Google Sign-In script is not available."
      : "Set GOOGLE_CLIENT_ID in the server environment to enable borrower login.";
    return;
  }

  window.google.accounts.id.initialize({
    client_id: state.config.googleClientId,
    callback: handleGoogleCredential
  });

  window.google.accounts.id.renderButton(document.querySelector("#google-login"), {
    theme: "outline",
    size: "large",
    shape: "pill",
    width: 280,
    text: "signin_with"
  });
}

async function handleGoogleCredential(response) {
  try {
    const data = await api("/api/auth/google", {
      method: "POST",
      body: JSON.stringify({ credential: response.credential })
    });
    state.borrower.user = data.user;
    state.borrower.application = data.application;
    state.borrower.currentStep = deriveStep(data.application);
    renderBorrower();
    subscribeBorrower();
  } catch (error) {
    els.authMessage.textContent = error.message;
  }
}

async function saveApplication(payload) {
  const response = await api("/api/application/save", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  return response.application;
}

function hydrateBorrowerApplication(application, desiredStep) {
  state.borrower.application = application;
  state.borrower.currentStep = desiredStep || deriveStep(application);
  if (application.bank?.selfieImage) {
    state.borrower.selfieImage = application.bank.selfieImage;
  }
  renderBorrower();
}

function renderBorrower() {
  const { user, application } = state.borrower;
  const loggedIn = Boolean(user);

  els.authPanel.classList.toggle("hidden", loggedIn);
  els.borrowerApp.classList.toggle("hidden", !loggedIn);
  els.borrowerLogout.classList.toggle("hidden", !loggedIn);

  if (!loggedIn) {
    return;
  }

  els.borrowerName.textContent = user.name || "Borrower";
  els.borrowerEmail.textContent = user.email || "";
  if (user.picture) {
    els.borrowerAvatar.src = user.picture;
    els.borrowerAvatar.classList.remove("hidden");
  } else {
    els.borrowerAvatar.classList.add("hidden");
  }

  const step = state.borrower.currentStep;
  document.querySelectorAll(".steps-list li").forEach((item) => {
    item.classList.toggle("active", Number(item.dataset.step) === step);
  });

  els.referenceNumber.textContent = application?.referenceNumber || "Not generated yet";
  els.lastSavedAt.textContent = formatDate(application?.updatedAt);
  els.resumeNote.textContent = application?.lastCompletedStep
    ? `Your progress is saved automatically. Resuming from step ${Math.min(step, 3)}.`
    : "Start your application below. Your progress will auto-save after each step.";

  updateStatusBadge(application?.status || "Pending");
  fillStepForms(application);
  renderEligibilityPanel(application?.eligibility);
  setBorrowerStep(step);
}

function fillStepForms(application) {
  const personal = application?.personal || {};
  els.step1Form.fullName.value = personal.fullName || state.borrower.user?.name || "";
  els.step1Form.email.value = personal.email || state.borrower.user?.email || "";
  els.step1Form.dateOfBirth.value = personal.dateOfBirth || "";
  els.step1Form.panNumber.value = "";
  els.step1Form.panNumber.placeholder = personal.panMasked ? `Saved: ${personal.panMasked}` : "";
  els.step1Form.aadhaarNumber.value = "";
  els.step1Form.aadhaarNumber.placeholder = personal.aadhaarMasked ? `Saved: ${personal.aadhaarMasked}` : "";
  els.step1Form.employmentType.value = personal.employmentType || "";
  els.step1Form.monthlySalary.value = personal.monthlySalary || "";
  if (personal.age) {
    els.ageValidation.textContent = personal.ageEligible ? `Age verified: ${personal.age} years.` : "Applicant must be at least 18 years old.";
  }

  const bank = application?.bank || {};
  els.step3Form.bankName.value = bank.bankName || "";
  els.step3Form.accountNumber.value = "";
  els.step3Form.accountNumber.placeholder = bank.accountMasked ? `Saved: ${bank.accountMasked}` : "";
  els.step3Form.ifscCode.value = bank.ifscCode || "";
  els.step3Form.eMandateConsent.checked = Boolean(bank.eMandateConsent);

  if (bank.selfieImage) {
    els.selfiePreview.src = bank.selfieImage;
    els.selfiePreview.classList.remove("hidden");
  }
}

async function refreshTracking() {
  if (!state.trackingReference) {
    return;
  }
  const result = await api(`/api/track?reference=${encodeURIComponent(state.trackingReference)}`);
  els.trackingResult.innerHTML = `
    <strong>${escapeHtml(result.status)}</strong>
    <p>Name: ${escapeHtml(result.name || "Applicant")}</p>
    <p>Reference: ${escapeHtml(result.referenceNumber)}</p>
    <p>Submitted: ${formatDate(result.submittedAt)}</p>
    <p class="muted small-text">This panel refreshes automatically for near real-time status changes.</p>
  `;
  els.trackingResult.classList.remove("muted");
}

function renderEligibilityPanel(eligibility) {
  if (!eligibility) {
    els.eligibilityCard.textContent = "Complete Step 1 to see your personalized offer range.";
    els.eligibilityCard.classList.add("muted");
    return;
  }
  els.eligibilityCard.innerHTML = renderEligibilityHtml(eligibility);
  els.eligibilityCard.classList.remove("muted");
}

function renderEligibilityHtml(eligibility) {
  const maximum = Number(eligibility.maximumOffer || 0);
  return `
    <strong>${escapeHtml(eligibility.message)}</strong>
    <p>Profile band: ${escapeHtml(eligibility.profileBand || "Developing")}</p>
    <p>Offer range: ${formatCurrency(eligibility.minimumOffer || 0)} to ${formatCurrency(maximum)}</p>
  `;
}

function setBorrowerStep(step) {
  state.borrower.currentStep = step;
  els.step1Form.classList.toggle("hidden", step !== 1);
  els.step2Panel.classList.toggle("hidden", step !== 2);
  els.step3Form.classList.toggle("hidden", step !== 3);
  document.querySelectorAll(".steps-list li").forEach((item) => {
    item.classList.toggle("active", Number(item.dataset.step) === step);
  });
}

function updateStatusBadge(status) {
  const normalized = String(status || "Pending");
  els.statusBadge.textContent = normalized;
  els.statusBadge.className = `status-pill ${normalized.toLowerCase()}`;
}

async function startCamera() {
  if (state.mediaStream) {
    return;
  }
  try {
    state.mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
    els.video.srcObject = state.mediaStream;
    els.video.classList.remove("hidden");
  } catch {
    alert("Unable to access camera. Please allow camera permission to capture your live selfie.");
  }
}

function captureSelfie() {
  if (!state.mediaStream) {
    alert("Start camera first.");
    return;
  }
  const videoTrack = els.video;
  const ctx = els.canvas.getContext("2d");
  els.canvas.width = videoTrack.videoWidth || 640;
  els.canvas.height = videoTrack.videoHeight || 480;
  ctx.drawImage(videoTrack, 0, 0, els.canvas.width, els.canvas.height);
  state.borrower.selfieImage = els.canvas.toDataURL("image/jpeg", 0.92);
  els.selfiePreview.src = state.borrower.selfieImage;
  els.selfiePreview.classList.remove("hidden");
  els.canvas.classList.add("hidden");
}

function stopCamera() {
  if (!state.mediaStream) {
    return;
  }
  state.mediaStream.getTracks().forEach((track) => track.stop());
  state.mediaStream = null;
  els.video.classList.add("hidden");
}

async function loadAdminApplications(query) {
  if (!state.admin.loggedIn) {
    return;
  }
  const data = await api(`/api/admin/applications?q=${encodeURIComponent(query || "")}`);
  state.admin.applications = data.applications;
  renderAdminApplications();
}

function renderAdmin() {
  els.adminAuthPanel.classList.toggle("hidden", state.admin.loggedIn);
  els.adminDashboard.classList.toggle("hidden", !state.admin.loggedIn);
  els.adminLogout.classList.toggle("hidden", !state.admin.loggedIn);
}

function renderAdminApplications() {
  if (!state.admin.applications.length) {
    els.adminList.innerHTML = `<article><strong>No applications found.</strong><p class="muted">Try a different search or wait for new submissions.</p></article>`;
    return;
  }

  els.adminList.innerHTML = state.admin.applications
    .map((application) => {
      const selfieBlock = application.bank?.selfieImage
        ? `<img src="${application.bank.selfieImage}" alt="Selfie verification" style="width:120px;border-radius:16px;" />`
        : `<span class="muted">Not captured</span>`;

      return `
        <article>
          <div class="admin-card-head">
            <div>
              <h3>${escapeHtml(application.personal?.fullName || "Applicant")}</h3>
              <p>${escapeHtml(application.personal?.email || application.email || "")}</p>
              <p>Reference: <strong>${escapeHtml(application.referenceNumber || "Not generated")}</strong></p>
              <p>Submitted: ${formatDate(application.submittedAt)}</p>
            </div>
            <span class="status-pill ${String(application.status || "Pending").toLowerCase()}">${escapeHtml(application.status || "Pending")}</span>
          </div>

          <div class="detail-grid">
            <div><strong>PAN</strong><p>${escapeHtml(application.personal?.panNumber || "-")}</p></div>
            <div><strong>Aadhaar</strong><p>${escapeHtml(application.personal?.aadhaarNumber || "-")}</p></div>
            <div><strong>Employment</strong><p>${escapeHtml(application.personal?.employmentType || "-")}</p></div>
            <div><strong>Salary</strong><p>${formatCurrency(application.personal?.monthlySalary || 0)}</p></div>
            <div><strong>Bank</strong><p>${escapeHtml(application.bank?.bankName || "-")}</p></div>
            <div><strong>Account / IFSC</strong><p>${escapeHtml(application.bank?.accountNumber || "-")} / ${escapeHtml(application.bank?.ifscCode || "-")}</p></div>
            <div><strong>Timestamp</strong><p>${formatDate(application.updatedAt)}</p></div>
            <div><strong>Selfie</strong><p>${selfieBlock}</p></div>
          </div>

          <div class="admin-card-actions">
            <button data-status="Pending" data-reference="${escapeHtml(application.referenceNumber || "")}" class="ghost-btn">Mark Pending</button>
            <button data-status="Approved" data-reference="${escapeHtml(application.referenceNumber || "")}" class="primary-btn">Approve</button>
            <button data-status="Rejected" data-reference="${escapeHtml(application.referenceNumber || "")}" class="secondary-btn">Reject</button>
          </div>
        </article>
      `;
    })
    .join("");

  els.adminList.querySelectorAll("button[data-reference]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api("/api/admin/status", {
        method: "POST",
        body: JSON.stringify({
          referenceNumber: button.dataset.reference,
          status: button.dataset.status
        })
      });
      await loadAdminApplications(els.adminSearch.value.trim());
    });
  });
}

function subscribeBorrower() {
  if (window.borrowerStream) {
    window.borrowerStream.close();
  }
  try {
    window.borrowerStream = new EventSource("/api/application/stream");
    window.borrowerStream.onmessage = (event) => {
      const application = JSON.parse(event.data);
      hydrateBorrowerApplication(application, deriveStep(application));
    };
  } catch {
    // Best-effort live updates.
  }
}

function subscribeAdmin() {
  if (window.adminStream) {
    window.adminStream.close();
  }
  try {
    window.adminStream = new EventSource("/api/admin/stream");
    window.adminStream.onmessage = () => {
      loadAdminApplications(els.adminSearch.value.trim());
    };
  } catch {
    // Best-effort live updates.
  }
}

function deriveStep(application) {
  if (!application) {
    return 1;
  }
  if (application.referenceNumber || application.lastCompletedStep >= 3) {
    return 3;
  }
  if (application.lastCompletedStep >= 1 || application.eligibility) {
    return 2;
  }
  return 1;
}

function calculateEligibility({ dateOfBirth, employmentType, monthlySalary }) {
  const age = calculateAge(dateOfBirth);
  const profileBand =
    age >= 25 && monthlySalary >= 25000 && String(employmentType).toLowerCase().includes("salar")
      ? "Strong"
      : age >= 21 && monthlySalary >= 15000
        ? "Moderate"
        : "Developing";

  let maximumOffer = age >= 21 ? 50000 : 25000;
  if (monthlySalary >= 25000) {
    maximumOffer = maximumOffer;
  } else if (monthlySalary >= 18000) {
    maximumOffer -= 5000;
  } else if (monthlySalary >= 12000) {
    maximumOffer -= 10000;
  } else if (monthlySalary > 0) {
    maximumOffer = 15000;
  } else {
    maximumOffer = 0;
  }

  if (String(employmentType).toLowerCase().includes("self") || String(employmentType).toLowerCase().includes("freel")) {
    maximumOffer = Math.max(5000, maximumOffer - 5000);
  }

  if (age < 18) {
    return {
      profileBand,
      minimumOffer: 0,
      maximumOffer: 0,
      message: "Applicant must be at least 18 years old."
    };
  }

  return {
    profileBand,
    minimumOffer: 5000,
    maximumOffer: Math.max(5000, maximumOffer),
    message: `Estimated facilitation range: ${formatCurrency(5000)} to ${formatCurrency(Math.max(5000, maximumOffer))}`
  };
}

function calculateAge(dateOfBirth) {
  if (!dateOfBirth) {
    return 0;
  }
  const dob = new Date(dateOfBirth);
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const month = now.getMonth() - dob.getMonth();
  if (month < 0 || (month === 0 && now.getDate() < dob.getDate())) {
    age -= 1;
  }
  return age;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    credentials: "include",
    ...options
  });

  const isJson = response.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await response.json() : null;
  if (!response.ok) {
    throw new Error(body?.error || "Request failed.");
  }
  return body;
}

function formToObject(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0
  }).format(Number(value || 0));
}

function formatDate(value) {
  if (!value) {
    return "Not available";
  }
  return new Date(value).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

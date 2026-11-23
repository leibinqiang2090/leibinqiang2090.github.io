const form = document.querySelector("#loginForm");
const codeInput = document.querySelector("#accessCode");
const errorMessage = document.querySelector("#errorMessage");
const loginButton = document.querySelector("#loginButton");
const toggleCode = document.querySelector("#toggleCode");
const CLOUD_CONFIG = window.XINGJINJU_CONFIG || {};
const SESSION_TOKEN_KEY = "xingjinju-session-token";

document.querySelector("#currentHost").textContent = location.host;

function appUrl(path = "") {
  return new URL(String(path).replace(/^\/+/, ""), CLOUD_CONFIG.appBase || location.href).href;
}

toggleCode.addEventListener("click", () => {
  const showing = codeInput.type === "text";
  codeInput.type = showing ? "password" : "text";
  toggleCode.textContent = showing ? "显示" : "隐藏";
  codeInput.focus();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = codeInput.value.trim();
  errorMessage.textContent = "";
  if (!code) {
    errorMessage.textContent = "请先输入访问验证码。";
    codeInput.focus();
    return;
  }

  loginButton.disabled = true;
  loginButton.firstChild.textContent = "正在验证 ";
  try {
    const response = await fetch(`${CLOUD_CONFIG.supabaseUrl}/rest/v1/rpc/app_login`, {
      method: "POST",
      headers: {
        apikey: CLOUD_CONFIG.publishableKey,
        Authorization: `Bearer ${CLOUD_CONFIG.publishableKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_code: code }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.ok) {
      throw new Error(payload.error || "验证失败，请重新输入。");
    }
    sessionStorage.setItem(SESSION_TOKEN_KEY, payload.token);
    location.replace(appUrl("index.html"));
  } catch (error) {
    errorMessage.textContent = error.message;
    codeInput.select();
  } finally {
    loginButton.disabled = false;
    loginButton.firstChild.textContent = "验证并进入 ";
  }
});

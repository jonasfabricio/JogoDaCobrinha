// Conta do jogador: tela de cadastro/login e sessão.
// A sessão fica num cookie HttpOnly criado pelo servidor (o JavaScript da página nunca vê o token).
window.Account = (() => {
  const $ = (s) => document.querySelector(s);
  let user = null;
  let mode = "register";
  let resolveLogin = null;

  async function api(path, body) {
    const options = body === undefined ? {} : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
    const res = await fetch(path, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Não foi possível falar com o servidor.");
    return data;
  }

  function setMode(next) {
    mode = next;
    const register = mode === "register";
    $("#auth-title").textContent = register ? "Crie sua conta" : "Bem-vindo de volta";
    $("#auth-sub").textContent = register
      ? "Cadastre-se para salvar seus recordes e disputar o pódio."
      : "Entre com seu email e senha para continuar.";
    $("#auth-submit").textContent = register ? "Criar conta" : "Entrar";
    $("#auth-switch-text").textContent = register ? "Já tem uma conta?" : "Ainda não tem conta?";
    $("#auth-switch").textContent = register ? "Já tenho uma conta" : "Criar uma conta nova";
    $("#auth-password").autocomplete = register ? "new-password" : "current-password";
    $("#auth-password").placeholder = register ? "Mínimo de 8 caracteres" : "Sua senha";
    $("#auth-error").textContent = "";
    $("#auth-email").focus();
  }

  function showLoggedIn() {
    $("#auth").hidden = true;
    $("#me-email").textContent = user.email;
    $("#me-email").title = user.email;
    renderBest();
    $("#me-panel").hidden = false;
    resolveLogin?.(user);
  }

  function renderBest() {
    $("#me-best").textContent = user.best.toLocaleString("pt-BR");
    $("#me-level").textContent = user.level ? `nível ${user.level}` : "nível —";
  }

  // Envia a pontuação; o servidor só grava se for maior que o recorde salvo.
  async function saveScore(score, level) {
    if (!user || score <= user.best) return;
    const data = await api("/api/score", { score, level }).catch(() => null);
    if (!data) return;
    user = data;
    renderBest();
    const panel = $("#me-panel");
    panel.classList.remove("pulse");
    void panel.offsetWidth; // reinicia a animação
    panel.classList.add("pulse");
    dispatchEvent(new Event("score:saved"));
  }

  $("#auth-switch").addEventListener("click", () => setMode(mode === "register" ? "login" : "register"));

  $("#auth-eye").addEventListener("click", () => {
    const input = $("#auth-password");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("#auth-eye").textContent = show ? "Ocultar" : "Mostrar";
    $("#auth-eye").setAttribute("aria-pressed", String(show));
  });

  $("#auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#auth-email").value.trim();
    const password = $("#auth-password").value;
    const error = $("#auth-error");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return void (error.textContent = "Informe um email válido.");
    if (password.length < 8) return void (error.textContent = "A senha precisa ter pelo menos 8 caracteres.");

    const button = $("#auth-submit");
    button.disabled = true;
    button.classList.add("loading");
    error.textContent = "";
    try {
      user = await api(mode === "register" ? "/api/register" : "/api/login", { email, password });
      $("#auth-password").value = "";
      showLoggedIn();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      button.disabled = false;
      button.classList.remove("loading");
    }
  });

  $("#logout").addEventListener("click", async () => {
    await api("/api/logout", {}).catch(() => {});
    location.reload();
  });

  // Resolve com o usuário logado; se não houver sessão, mostra a tela de login e espera.
  async function requireLogin() {
    if (location.protocol === "file:") {
      $("#auth").hidden = false;
      setMode("register");
      $("#auth-error").textContent = "Para usar contas, rode “npm start” e abra http://localhost:3000";
      $("#auth-submit").disabled = true;
      return new Promise(() => {});
    }
    user = await api("/api/me").catch(() => null);
    return new Promise((resolve) => {
      resolveLogin = resolve;
      if (user) return showLoggedIn();
      $("#auth").hidden = false;
      setMode("register");
    });
  }

  // Começa já, sem esperar o Three.js carregar da CDN.
  const ready = requireLogin();

  return { ready, saveScore, get user() { return user; }, api };
})();

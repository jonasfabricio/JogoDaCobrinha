// Conquistas: catálogo, desbloqueio (salvo na conta pelo servidor) e painel "Seu recorde".
window.Achievements = (() => {
  const CATALOG = [
    { code: "primeira_fuga", icon: "🚪", name: "Primeira fuga", desc: "Conclua um nível." },
    { code: "explorador", icon: "🧭", name: "Explorador", desc: "Chegue ao nível 5." },
    { code: "mestre", icon: "👑", name: "Mestre do labirinto", desc: "Chegue ao nível 10." },
    { code: "intocavel", icon: "🛡️", name: "Intocável", desc: "Conclua um nível sem levar dano." },
    { code: "colecionador", icon: "💎", name: "Colecionador", desc: "Pegue todos os cristais de um nível." },
    { code: "em_chamas", icon: "🔥", name: "Em chamas", desc: "Chegue ao combo ×5." },
    { code: "esmagador", icon: "💥", name: "Esmagador", desc: "Esmague 10 monstros numa partida." },
    { code: "sem_medo", icon: "🌑", name: "Sem medo do escuro", desc: "Conclua um nível no escuro." },
    { code: "relampago", icon: "⚡", name: "Relâmpago", desc: "Conclua um labirinto de 21×21 ou maior em menos de 40 s." },
  ];
  const unlocked = new Set();
  const list = document.querySelector("#ach-list");
  const count = document.querySelector("#ach-count");
  const card = document.querySelector("#ach-toast");

  function render() {
    list.replaceChildren(...CATALOG.map((a) => {
      const li = document.createElement("li");
      const got = unlocked.has(a.code);
      li.className = got ? "got" : "";
      li.textContent = a.icon;
      li.title = `${a.name}${got ? "" : " (bloqueada)"}: ${a.desc}`;
      li.setAttribute("aria-label", li.title);
      return li;
    }));
    count.textContent = `${unlocked.size}/${CATALOG.length}`;
  }

  // Cartão "Conquista desbloqueada"; várias de uma vez entram numa fila.
  const queue = [];
  let showing = false;
  function showNext() {
    const a = queue.shift();
    if (!a) { showing = false; return; }
    showing = true;
    card.querySelector(".ach-icon").textContent = a.icon;
    card.querySelector("b").textContent = a.name;
    card.querySelector("small").textContent = "Conquista desbloqueada";
    card.classList.add("show");
    Sfx.achievement();
    setTimeout(() => { card.classList.remove("show"); setTimeout(showNext, 350); }, 2600);
  }

  function unlock(code) {
    if (unlocked.has(code) || !Account.user) return;
    const a = CATALOG.find((x) => x.code === code);
    if (!a) return;
    unlocked.add(code);
    render();
    queue.push(a);
    if (!showing) showNext();
    // se o servidor falhar, desfaz para tentar de novo da próxima vez
    Account.api("/api/achievements", { code }).catch(() => { unlocked.delete(code); render(); });
  }

  Account.ready.then((user) => {
    for (const code of user.achievements || []) unlocked.add(code);
    render();
  });

  return { unlock };
})();

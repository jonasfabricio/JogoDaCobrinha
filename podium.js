// Pódio: os 3 melhores jogadores, sempre visível durante a partida.
(() => {
  const panel = document.querySelector("#podium");
  const list = document.querySelector("#podium-list");
  const MEDALS = ["gold", "silver", "bronze"];

  function render(top) {
    list.replaceChildren();
    if (!top.length) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "Ninguém no pódio ainda. Seja o primeiro!";
      list.append(empty);
      return;
    }
    top.forEach((player, i) => {
      const li = document.createElement("li");
      li.className = `place ${MEDALS[i]}${player.you ? " you" : ""}`;
      const medal = document.createElement("span");
      medal.className = "medal";
      medal.textContent = i + 1;
      medal.setAttribute("aria-label", ["Ouro", "Prata", "Bronze"][i]);
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = player.you ? `${player.name} (você)` : player.name;
      const score = document.createElement("strong");
      score.textContent = player.best.toLocaleString("pt-BR");
      li.append(medal, name, score);
      list.append(li);
    });
  }

  async function refresh() {
    const top = await Account.api("/api/podium").catch(() => null);
    if (top) render(top);
  }

  Account.ready.then(() => {
    panel.hidden = false;
    refresh();
    setInterval(refresh, 15000);
    addEventListener("score:saved", refresh);
  });
})();

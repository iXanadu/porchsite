// Writing search: filters /writing/search.json in the browser.
// Progressive: without JS the page is a plain list and the box stays hidden.
(function () {
  var box = document.querySelector(".search");
  var input = document.getElementById("q");
  var results = document.getElementById("results");
  var all = document.getElementById("all");
  if (!box || !input || !results || !all) return;
  box.hidden = false;

  var index = null;
  function load() {
    if (index) return Promise.resolve(index);
    return fetch(input.dataset.index).then(function (r) { return r.json(); })
      .then(function (rows) { index = rows; return rows; });
  }

  function card(row) {
    var a = document.createElement("a");
    a.className = "writing";
    a.href = row.u;
    var text = document.createElement("span");
    text.className = "writing-text";
    var t = document.createElement("span");
    t.className = "writing-title";
    t.textContent = row.t;
    var s = document.createElement("span");
    s.className = "writing-summary";
    s.textContent = row.s;
    text.append(t, s);
    var meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = row.d + " · " + row.l + (row.x ? " ↗" : "");
    a.append(text, meta);
    return a;
  }

  function run() {
    var q = input.value.trim().toLowerCase();
    if (!q) { results.hidden = true; all.hidden = false; return; }
    load().then(function (rows) {
      var words = q.split(/\s+/);
      var hits = rows.filter(function (r) {
        var hay = (r.t + " " + r.s + " " + r.g.join(" ") + " " + r.b).toLowerCase();
        return words.every(function (w) { return hay.indexOf(w.replace(/^#/, "")) !== -1; });
      });
      results.replaceChildren.apply(results, hits.map(card));
      if (!hits.length) {
        var p = document.createElement("p");
        p.className = "lede";
        p.textContent = "Nothing matches “" + input.value.trim() + "”.";
        results.append(p);
      }
      results.hidden = false;
      all.hidden = true;
    });
  }

  input.addEventListener("focus", load, { once: true });
  input.addEventListener("input", run);
})();

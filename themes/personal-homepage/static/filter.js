// Project filter chips on the home page.
// Progressive: without JS every card shows and the chips stay hidden.
(function () {
  var bar = document.querySelector(".chips");
  var section = bar && bar.closest("section");
  if (!section) return;
  var chips = bar.querySelectorAll(".chip");
  var cards = section.querySelectorAll(".card[data-group]");
  bar.hidden = false;

  function apply(group) {
    cards.forEach(function (c) { c.hidden = !!group && c.dataset.group !== group; });
    // A grid with nothing left in it goes too, along with the label above it.
    section.querySelectorAll(".cards").forEach(function (grid) {
      var any = grid.querySelector(".card:not([hidden])");
      grid.hidden = !any;
      var label = grid.previousElementSibling;
      if (label && label.classList.contains("group-label")) label.hidden = !any;
    });
    chips.forEach(function (c) {
      c.setAttribute("aria-pressed", String((c.dataset.filter || "") === group));
    });
  }

  bar.addEventListener("click", function (e) {
    var chip = e.target.closest(".chip");
    if (chip) apply(chip.dataset.filter || "");
  });
})();

document.addEventListener("DOMContentLoaded", function() {
  const cards = document.querySelectorAll(".card");
  const urlParams = new URLSearchParams(window.location.search);
  const filter = urlParams.get("filter") || "all";

  cards.forEach(card => {
    if (filter === "all") {
      card.style.display = "block";
    } else {
      if (card.getAttribute("data-category") === filter) {
        card.style.display = "block";
      } else {
        card.style.display = "none";
      }
    }
  });
});

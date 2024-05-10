const cart = JSON.parse(localStorage.getItem("cart")) || [];
let totalPrice = 0.00;
let itemCountMap = new Map();
let priceMap = new Map([["sushiSalmao", 12.99],
  ["hot", 14.99],
  ["temakiSalmao", 17.99],
  ["sashimiSalmao", 13.99],
  ["sashimiAtum", 15.99],
  ["bigMac", 14.99],
  ["mcLanche", 12.99],
  ["mcNuggets", 8.99],
  ["mcFritas", 8.99],
  ["milkshakeOvomaltine", 18.99],
  ["whopper", 11.99],
  ["sundaeOvomaltine", 12.99],
  ["megaStacker", 21.99],
  ["batataSuprema", 23.99],
  ["onionRings", 18.99],
  ["insalata", 15.99],
  ["bruschetta", 17.99],
  ["pizzaBianca", 9.99],
  ["mille", 23.99],
  ["pici", 19.99]]);
let idMap = new Map([["sushiSalmao", "np1"],
  ["hot", "np2"],
  ["temakiSalmao", "np3"],
  ["sashimiAtum", "np4"],
  ["sashimiSalmao", "np5"],
  ["bigMac", "mp1"],
  ["mcLanche", "mp2"],
  ["mcNuggets", "mp3"],
  ["mcFritas", "mp4"],
  ["milkshakeOvomaltine", "mp5"],
  ["whopper", "bp1"],
  ["sundaeOvomaltine", "bp2"],
  ["megaStacker", "bp3"],
  ["batataSuprema", "bp4"],
  ["onionRings", "bp5"],
  ["insalata", "gp1"],
  ["bruschetta", "gp2"],
  ["pizzaBianca", "gp3"],
  ["mille", "gp4"],
  ["pici", "gp5"]]);

function addItemToCart(itemId, itemData) {
  cart.push(itemData);
  localStorage.setItem("cart", JSON.stringify(cart));
  updateItemCountMap(itemData);
  updateItemDisplay(itemId, itemData);
  updateTotalPrice();
}

function removeItemFromCart(itemId, itemData) {
  const index = cart.indexOf(itemData);
  if (index!== -1) {
    cart.splice(index, 1);
    localStorage.setItem("cart", JSON.stringify(cart));
    updateItemCountMap(itemData, -1);
    updateItemDisplay(itemId, itemData);
    updateTotalPrice();
  }
}

function blankCart() {
  cart.length = 0;
  localStorage.setItem("cart", JSON.stringify(cart));
  itemCountMap.clear();
  updateTotalPrice();
  addCartCard();
}

function updateItemCountMap(itemData, increment = 1) {
  const count = itemCountMap.get(itemData) || 0;
  itemCountMap.set(itemData, count + increment);
}

function updateItemDisplay(itemId, itemData) {
  count = 0;
  for (let i = 0; i < cart.length; i++) {
    if (cart[i] === itemData) {
      count = count + 1;
    }
  }
  document.getElementById(itemId).innerHTML = count;
}

function updateTotalPrice() {
  totalPrice = 0.00;
  for (let i = 0; i < cart.length; i++) {
    const j = priceMap.get(cart[i]);
    totalPrice += j;
  }
  document.getElementById("pCart2").textContent = `R$ ${totalPrice.toFixed(2)}`;
}

function addCartCard() {
  var baseDiv = document.getElementById("baseDIV");
  baseDiv.innerHTML = "";
  for (let i = 0; i<cart.length; i++) {
    const itemData = cart[i];
    count = 0;
    if (cart.indexOf(itemData) != i) {
      continue;
    }
    for (let i = 0; i < cart.length; i++) {
      if (cart[i] === itemData) {
        count = count + 1;
      }
    }
    const itemId = idMap.get(itemData);
    var productName = "";
    const productPrice = priceMap.get(itemData);
    if (itemData === "sushiSalmao") {
      productName = "Sushi de Salmão";
    } else if (itemData === "hot") {
      productName = "Hot Philadelphia";
    } else if (itemData === "temakiSalmao") {
      productName = "Temaki de Salmão";
    } else if (itemData === "sashimiAtum") {
      productName = "Sashimi de Atum";
    } else if (itemData === "sashimiSalmao") {
      productName = "Sashimi de Salmão";
    } else if (itemData === "bigMac") {
      productName = "Big Mac";
    } else if (itemData === "mcLanche") {
      productName = "McLanche Feliz";
    } else if (itemData === "mcNuggets") {
      productName = "McNuggets";
    } else if (itemData === "mcFritas") {
      productName = "Mc Fritas";
    } else if (itemData === "milkshakeOvomaltine") {
      productName = "Milkshake Ovomaltine";
    } else if (itemData === "whopper") {
      productName = "Whopper";
    } else if (itemData === "sundaeOvomaltine") {
      productName = "Sundae de Ovomaltine";
    } else if (itemData === "megaStacker") {
      productName = "Mega Stacker 2.0";
    } else if (itemData === "batataSuprema") {
      productName = "Batata Suprema";
    } else if (itemData === "onionRings") {
      productName = "Onion Rings";
    } else if (itemData === "insalata") {
      productName = "Insalata Gabbiano";
    } else if (itemData === "bruschetta") {
      productName = "Bruschetta";
    } else if (itemData === "pizzaBianca") {
      productName = "Pizza Bianca con Parmigiano";
    } else if (itemData === "mille") {
      productName = "Mille Foglie";
    } else if (itemData === "pici") {
      productName = "Pici All’Aglione";
    } else {
      productName = "ERROR: Unknown product"
    }
    baseDiv.innerHTML += "<div class='card' style='width: 48rem; margin-left: 550px; margin-right: 550px; margin-bottom: 50px;'><img src='...' class='card-img-top'><div class='card-body'><h5 class='card-title'>" + productName + "</h5><p class='card-text'><b>" + productPrice + "</b></p><p style='text-align: center;' class='card-text' id='" + itemId + "'>" + count + "</p><button onclick='removeItemFromCart(" + itemId + ", " + itemData + ")' style='margin-left: 321px;' type='button' class='btn btn-outline-light'><img class='but1' src='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxZW0iIGhlaWdodD0iMWVtIiB2aWV3Qm94PSIwIDAgMTYgMTYiPjxnIGZpbGw9ImN1cnJlbnRDb2xvciI+PHBhdGggZD0iTTYuNSA3YS41LjUgMCAwIDAgMCAxaDRhLjUuNSAwIDAgMCAwLTF6Ii8+PHBhdGggZD0iTS41IDFhLjUuNSAwIDAgMCAwIDFoMS4xMWwuNDAxIDEuNjA3bDEuNDk4IDcuOTg1QS41LjUgMCAwIDAgNCAxMmgxYTIgMiAwIDEgMCAwIDRhMiAyIDAgMCAwIDAtNGg3YTIgMiAwIDEgMCAwIDRhMiAyIDAgMCAwIDAtNGgxYS41LjUgMCAwIDAgLjQ5MS0uNDA4bDEuNS04QS41LjUgMCAwIDAgMTQuNSAzSDIuODlsLS40MDUtMS42MjFBLjUuNSAwIDAgMCAyIDF6bTMuOTE1IDEwTDMuMTAyIDRoMTAuNzk2bC0xLjMxMyA3ek02IDE0YTEgMSAwIDEgMS0yIDBhMSAxIDAgMCAxIDIgMG03IDBhMSAxIDAgMSAxLTIgMGExIDEgMCAwIDEgMiAwIi8+PC9nPjwvc3ZnPg=='></button><button style='margin-right: 321px;' onclick='addItemToCart(" + itemId + ", " + itemData + ")' type='button' class='btn btn-outline-light'><img class='but1' src='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxZW0iIGhlaWdodD0iMWVtIiB2aWV3Qm94PSIwIDAgMTYgMTYiPjxnIGZpbGw9ImN1cnJlbnRDb2xvciI+PHBhdGggZD0iTTkgNS41YS41LjUgMCAwIDAtMSAwVjdINi41YS41LjUgMCAwIDAgMCAxSDh2MS41YS41LjUgMCAwIDAgMSAwVjhoMS41YS41LjUgMCAwIDAgMC0xSDl6Ii8+PHBhdGggZD0iTS41IDFhLjUuNSAwIDAgMCAwIDFoMS4xMWwuNDAxIDEuNjA3bDEuNDk4IDcuOTg1QS41LjUgMCAwIDAgNCAxMmgxYTIgMiAwIDEgMCAwIDRhMiAyIDAgMCAwIDAtNGg3YTIgMiAwIDEgMCAwIDRhMiAyIDAgMCAwIDAtNGgxYS41LjUgMCAwIDAgLjQ5MS0uNDA4bDEuNS04QS41LjUgMCAwIDAgMTQuNSAzSDIuODlsLS40MDUtMS42MjFBLjUuNSAwIDAgMCAyIDF6bTMuOTE1IDEwTDMuMTAyIDRoMTAuNzk2bC0xLjMxMyA3ek02IDE0YTEgMSAwIDEgMS0yIDBhMSAxIDAgMCAxIDIgMG03IDBhMSAxIDAgMSAxLTIgMGExIDEgMCAwIDEgMiAwIi8+PC9nPjwvc3ZnPg=='></button></div></div>"
  }
}

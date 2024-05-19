emailjs.init({
    publicKey: "KEu1x-teiGVB_dZUD",
});

function sendEmail() {
  var params = {
    name : document.getElementById("name").value,
    request : document.getElementById("request").value,
    email : document.getElementById("email").value
  }
  emailjs.send("service_5mcxryi", "template_3wsttqj", params).then(function (res) {
    alert("Success!" + res.status);
  })
}

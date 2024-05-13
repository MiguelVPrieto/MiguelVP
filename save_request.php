<!-- save_request.php -->
<?php
// Configuration
$db_host = 'localhost';
$db_username = 'your_username';
$db_password = 'your_password';
$db_name = 'your_database';

// Create connection
$conn = new mysqli($db_host, $db_username, $db_password, $db_name);

// Check connection
if ($conn->connect_error) {
  die("Connection failed: ". $conn->connect_error);
}

// Get input values from the form
$request = $_POST['request'];
$name = $_POST['name'];
$email = $_POST['email'];

// Insert data into the database
$sql = "INSERT INTO requests (request, name, email) VALUES (?,?,?)";
$stmt = $conn->prepare($sql);
$stmt->bind_param("sss", $request, $name, $email);
$stmt->execute();

if ($stmt->affected_rows > 0) {
  echo "Request saved successfully!";
} else {
  echo "Error saving request: ". $stmt->error;
}

$stmt->close();
$conn->close();
?>

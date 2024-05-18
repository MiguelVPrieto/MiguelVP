const emailjs = require('emailjs-com');
const { YOUR_USER_ID, YOUR_SERVICE_ID, YOUR_TEMPLATE_ID } = process.env;

exports.handler = async function(event, context) {
  const data = JSON.parse(event.body);

  emailjs.init(YOUR_USER_ID);

  try {
    const response = await emailjs.send(YOUR_SERVICE_ID, YOUR_TEMPLATE_ID, data);
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Email sent successfully' })
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Failed to send email', error })
    };
  }
};

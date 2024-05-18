const emailjs = require('emailjs-com');

exports.handler = async function(event, context) {
  const data = JSON.parse(event.body);
  emailjs.init(OuOrAaTX1fcs34oH3pnPb);

  try {
    const response = await emailjs.send(service_5mcxryi, template_3wsttqj, data);
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

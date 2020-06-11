import dotenv from 'dotenv';
import express from 'express';
const asyncHandler = require('express-async-handler');
import {createEventAdapter} from '@slack/events-api';
import {MongoClient} from 'mongodb';

dotenv.config();

const app = express();
const port = 3000;

const MONGO_URI = process.env.MONGO_URI;
const MONGO_DB_NAME = process.env.MONGO_DB_NAME;

app.use(express.json());
// to support URL-encoded bodies
app.use(express.urlencoded({
  extended: true,
}));
const slackEvents = createEventAdapter(process.env.SLACK_SIGNING_SECRET);
app.use('/event', slackEvents.expressMiddleware());

app.get('/', (req, res) => res.send('Hello World!'));

// For events like reactions
app.get('/event', (req, res) => console.log(res.body));

// For bot commands
app.post('/command', asyncHandler(async (req, res) => {
  // console.log(req.body);

  const commandArray = req.body.text.split(' ');
  const command = commandArray[0];
  let eventId = '';

  if (command == 'create') {
    eventId = commandArray[1];
  } else {
    eventId = commandArray[0];
  }

  if (!isValidId(eventId)) {
    res.send('Cannot parse event id.');
    return;
  }

  if (command == 'create') {
    // Create a new event

    const idExists = await isExistentId(eventId);

    if (idExists) {
      const message = `Event \`${eventId}\` already exists.`;
      res.send(message);
      return;
    }

    await createEvent(eventId);
    const message = `Event created successfully. \
Use this ID to add questions: \`${eventId}\``;
    res.send(message);
    return;
  } else {
    // Post a question for the event
    const idExists = await isExistentId(eventId);
    if (!idExists) {
      const message = `Event \`${eventId}\` does not yet exist.`;
      res.send(message);
      return;
    }

    res.send('Question was successfully added.');
    return;
  }
}));

app.listen(port, () =>
  console.log(`Example app listening at http://localhost:${port}`));

/**
 * Check if event identifier is valid.
 * Allowed symbols: lower case letters, digits and dashes.
 * Must sturt with a letter.
 * @param {string} id Event identifier
 * @return {boolean} true if identifier is valid
 */
function isValidId(id) {
  const properIdRegex = RegExp(
      '^[a-z]+(([a-z]|[0-9])*(\-){0,1}([a-z]|[0-9])+)+');
  return properIdRegex.test(id);
}


/**
 * Check if event with this identifier was created earlier.
 * @param {string} id Event identifier.
 * @return {boolean} true if id exists in the database.
 */
async function isExistentId(id) {
  const mongoClient = await MongoClient.connect(MONGO_URI,
      {useUnifiedTopology: true});

  const database = mongoClient.db(MONGO_DB_NAME);

  const event = {
    eventId: id,
  };

  const queryResult = await database.collection('events').findOne(event);
  if (queryResult != null) {
    return true;
  }

  return false;
}


/**
 * Creates a new Q&A event such as Town Hall, All-Hands, etc.
 * @param {string} eventId Event identifier, lowercase string with dashes.
 * @return {string} Success/error message if event was / wasn't created.
 */
async function createEvent(eventId) {
  const mongoClient = await MongoClient.connect(MONGO_URI,
      {useUnifiedTopology: true});

  const database = mongoClient.db(MONGO_DB_NAME);

  const event = {
    eventId: eventId,
  };

  const queryResult = await database.collection('events').insertOne(event);
  return queryResult;
}

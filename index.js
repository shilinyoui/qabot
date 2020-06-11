import dotenv from 'dotenv';
import express from 'express';
import asyncHandler from 'express-async-handler';
import {WebClient} from '@slack/web-api';
import {createEventAdapter} from '@slack/events-api';
import {MongoClient} from 'mongodb';

dotenv.config();

const app = express();
const port = 3000;

const MONGO_URI = process.env.MONGO_URI;
const MONGO_DB_NAME = process.env.MONGO_DB_NAME;

const slack = new WebClient(process.env.SLACK_ACCESS_TOKEN);

const slackEvents = createEventAdapter(process.env.SLACK_SIGNING_SECRET);
app.use('/event', slackEvents.expressMiddleware());

// to support URL-encoded bodies
app.use(express.urlencoded({
  extended: true,
}));
app.use(express.json());

app.listen(port, () =>
  console.log(`Example app listening at http://localhost:${port}`));

app.get('/', (req, res) => res.send('Hello World!'));

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
    res.status(201).send(message);
    return;
  } else {
    // Post a question for the event
    const idExists = await isExistentId(eventId);
    if (!idExists) {
      const message = `Event \`${eventId}\` does not yet exist.`;
      res.send(message);
      return;
    }

    const questionBody = commandArray.slice(1).join(' ');
    const createResult = await createQuestion(eventId, questionBody);
    const postResult = await postToSlack(eventId, questionBody);
    await updateQuestionWithMessageId(createResult.insertedId, postResult.ts);

    res.status(201).send('Question was successfully added.');
    return;
  }
}));

slackEvents.on('reaction_added', async (event) => {
  try {
    if (event.item_user != process.env.SLACK_QABOT_USER_ID) {
      return;
    }

    const reaction = event.reaction;
    const messageId = event.item.ts;

    if (reaction == '+1') {
      const updatedEntry = await updateQuestionVotes(messageId,
          {upvotes: 1, downvotes: 0});
      updateSlackMessage(updatedEntry.value);
    } else if (reaction == '-1') {
      const updatedEntry = await updateQuestionVotes(messageId,
          {upvotes: 0, downvotes: 1});
      updateSlackMessage(updatedEntry.value);
    }

    console.log('Reactions updated.');
  } catch (error) {
    console.log(error);
  }
});

slackEvents.on('reaction_removed', async (event) => {
  try {
    if (event.item_user != process.env.SLACK_QABOT_USER_ID) {
      return;
    }

    const reaction = event.reaction;
    const messageId = event.item.ts;

    if (reaction == '+1') {
      const updatedEntry = await updateQuestionVotes(messageId,
          {upvotes: -1, downvotes: 0});
      updateSlackMessage(updatedEntry.value);
    } else if (reaction == '-1') {
      const updatedEntry = await updateQuestionVotes(messageId,
          {upvotes: 0, downvotes: -1});
      updateSlackMessage(updatedEntry.value);
    }

    console.log('Reactions updated.');
  } catch (error) {
    console.log(error);
  }
});

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
 * @return {Promise} Database insert result.
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

/**
 * Create a new entry in the database with the question.
 * @param {string} eventId Event identifier, lowercase string with dashes.
 * @param {string} text Question body.
 * @return {Promise} Database insert result.
 */
async function createQuestion(eventId, text) {
  const mongoClient = await MongoClient.connect(MONGO_URI,
      {useUnifiedTopology: true});

  const database = mongoClient.db(MONGO_DB_NAME);

  const question = {
    eventId: eventId,
    text: text,
    upvotes: 0,
    downvotes: 0,
  };

  const queryResult =
    await database.collection('questions').insertOne(question);

  return queryResult;
}

/**
 * Update a question entry in the database with the slack message id.
 * This is needed later to increase/decrease upvotes and downvotes
 * for a specific question
 * @param {string} mongoId MongoDB question id.
 * @param {string} messageId Slack message id.
 * @return {Promise} Database insert result.
 */
async function updateQuestionWithMessageId(mongoId, messageId) {
  const mongoClient = await MongoClient.connect(MONGO_URI,
      {useUnifiedTopology: true});

  const database = mongoClient.db(MONGO_DB_NAME);

  const question = {
    _id: mongoId,
  };

  const updatedData = {
    $set: {
      slackId: messageId,
    },
  };

  const queryResult =
    await database.collection('questions').updateOne(question, updatedData);

  return queryResult;
}

/**
 * Post a question to the slack channel.
 * @param {string} eventId Event identifier, lowercase string with dashes.
 * @param {string} text Question body.
 * @return {Promise} Result of posting to a slack channel.
 */
async function postToSlack(eventId, text) {
  const message = `New question for event \`${eventId}\`: \n *${text}*`;
  const postResult = await slack.chat.postMessage({
    channel: process.env.SLACK_CHANNEL_ID,
    text: message,
  });
  return postResult;
}

/**
 * Update votes for the question entry in the database.
 * @param {string} messageId Slack message id.
 * @param {Map} votes Increments of {upvotes, downvotes}, e.g. [+1, -1]
 * @return {Promise} Database update result that includes an updated entry.
 */
async function updateQuestionVotes(messageId, votes) {
  const {upvotes, downvotes} = votes;

  const mongoClient = await MongoClient.connect(MONGO_URI,
      {useUnifiedTopology: true});

  const database = mongoClient.db(MONGO_DB_NAME);

  const question = {
    slackId: messageId,
  };

  const updatedData = {
    $inc: {
      upvotes: upvotes,
      downvotes: downvotes,
    },
  };

  const queryResult =
    await database.collection('questions').findOneAndUpdate(question,
        updatedData, {returnOriginal: false});

  return queryResult;
}

/**
 * Update posted message with the new data (question was upvoted/downvoted).
 * @param {Object} questionData Question entry from the database.
 * @return {Promise} Result of updating a slack message.
 */
async function updateSlackMessage(questionData) {
  const eventId = questionData.eventId;
  const questionBody = questionData.text;
  const upvotes = questionData.upvotes;
  const downvotes = questionData.downvotes;
  const messageId = questionData.slackId;

  const updatedMessage = `New question for event \`${eventId}\`: \n \
*${questionBody}*\n:+1: = ${upvotes}, :-1: = ${downvotes}`;
  const result = await slack.chat.update({
    channel: process.env.SLACK_CHANNEL_ID,
    ts: messageId,
    text: updatedMessage,
  });

  return result;
}

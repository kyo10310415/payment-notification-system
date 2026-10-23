const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createOperationalLogger } = require('../src/operational-log');

const sensitive = ['PRIVATE_STUDENT_NAME', 'PRIVATE_PAYMENT_MESSAGE', 'PRIVATE_REPLY_NAME',
  'PRIVATE_REPLY_CONTENT', 'PRIVATE_REACTION_NAME', 'PRIVATE_GUILD_NAME', 'PRIVATE_CHANNEL_NAME'];

test('real notification flow keeps message/reply/reaction details in Slack but out of logs', async () => {
  const lines = [], deliveries = [];
  const output = { log: (...args) => lines.push(args.join(' ')), error: (...args) => lines.push(args.join(' ')) };
  const source = fs.readFileSync(path.join(__dirname, '../src/discord-slack-notifier.js'), 'utf8');
  const context = vm.createContext({ console: output, __dirname: path.join(__dirname, '../src'),
    module: { exports: {} }, require: name => name === './operational-log'
      ? { logEvent: createOperationalLogger(output) } : name === 'https' ? {} : require(name),
    process: { env: {}, exit() { throw new Error('Unexpected exit'); } },
    setTimeout: fn => { fn(); return 0; }, clearTimeout() {},
    config: { discordToken: 'fixture', slackWebhookUrl: 'fixture', guildIds: ['fixture'], keywords: [],
      excludeKeywords: [], excludeUserIds: [], excludeUsernames: [], checkIntervalHours: 12 },
    match: { messageId: 'PRIVATE_MESSAGE_ID', channelId: 'PRIVATE_CHANNEL_ID', guildId: 'PRIVATE_GUILD_ID',
      guildName: sensitive[5], channelName: sensitive[6], author: sensitive[0], content: sensitive[1],
      messageUrl: 'https://example.invalid/private', messageTime: Date.now() },
    reaction: { emoji: 'fixture', users: [{ id: 'fixture', username: sensitive[4] }] },
    reply: { id: 'fixture', author: { username: sensitive[2] }, content: sensitive[3] },
    deliveries,
  });
  vm.runInContext(source, context);
  vm.runInContext(`
    loadConfig = () => config;
    processGuild = async () => ({ channelCount: 1, results: [{ messageCount: 1, matches: [match] }] });
    loadTrackedMessages = () => ({ messages: [] });
    saveTrackedMessages = () => {};
    getMessageReactions = async () => [reaction];
    getMessageReplies = async () => [reply];
    sendSlackNotification = async (_url, body) => { deliveries.push(body); return '{"ts":"fixture"}'; };
    sendSlackThreadReply = async (_url, _ts, body) => { deliveries.push(body); };
  `, context);
  await vm.runInContext('main()', context);
  const logs = lines.join('\n');
  for (const value of [...sensitive, 'PRIVATE_MESSAGE_ID', 'PRIVATE_CHANNEL_ID', 'PRIVATE_GUILD_ID']) {
    assert.equal(logs.includes(value), false);
  }
  for (const value of sensitive) assert.equal(JSON.stringify(deliveries).includes(value), true);
  assert.match(logs, /payment-detected.*event=[a-f0-9]{16}/);
  assert.match(logs, /reply-detected/);
  assert.match(logs, /reaction-detected/);
});

test('event references correlate within a run, change across runs, and never include the identifier', () => {
  const a = [], b = [];
  const one = createOperationalLogger({ log: line => a.push(line) });
  const two = createOperationalLogger({ log: line => b.push(line) });
  one('payment-detected', 'PRIVATE_ID'); one('payment-detected', 'PRIVATE_ID');
  two('payment-detected', 'PRIVATE_ID');
  assert.equal(a[0], a[1]); assert.notEqual(a[0], b[0]);
  assert.equal(a[0].includes('PRIVATE_ID'), false);
  assert.throws(() => one('PRIVATE_CONTENT', 'PRIVATE_ID'));
});

test('real channel filtering never logs webhook author details or raw API errors', async () => {
  const lines = [];
  const output = { log: (...args) => lines.push(args.join(' ')), error: (...args) => lines.push(args.join(' ')) };
  const context = vm.createContext({ console: output, __dirname,
    module: { exports: {} }, require: name => name === './operational-log'
      ? { logEvent: createOperationalLogger(output) } : name === 'https' ? {} : require(name),
    message: { id: 'PRIVATE_MESSAGE_ID', webhook_id: 'fixture', content: '支払い_PRIVATE_CONTENT',
      author: { id: 'PRIVATE_AUTHOR_ID', username: 'PRIVATE_AUTHOR_NAME', bot: true } },
    config: { discordToken: 'fixture', keywords: ['支払い'], excludeKeywords: [],
      excludeUserIds: [], excludeUsernames: ['PRIVATE_AUTHOR_NAME'] },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/discord-slack-notifier.js'), 'utf8'), context);
  vm.runInContext('discordRequest = async () => [message]; snowflakeToTimestamp = () => Date.now();', context);
  const filtered = await vm.runInContext("processChannel({id:'fixture',name:'PRIVATE_CHANNEL'}, 'fixture', 'PRIVATE_GUILD', config, 0)", context);
  assert.equal(filtered.matches.length, 0);
  vm.runInContext("discordRequest = async () => { throw new Error('PRIVATE_API_ERROR'); };", context);
  await vm.runInContext("processGuild('fixture',0,1,config,0)", context);
  assert.equal(lines.join('\n').includes('PRIVATE_'), false);
  assert.match(lines.join('\n'), /message-filtered/);
  assert.match(lines.join('\n'), /operation-failed/);
});

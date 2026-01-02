const https = require('https');
const fs = require('fs');
const path = require('path');

// 環境変数または設定ファイルから設定を読み込む
function loadConfig() {
  const config = {
    discordToken: process.env.DISCORD_BOT_TOKEN,
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
    guildIds: [],
    keywords: [],
    excludeKeywords: [],
    checkIntervalHours: 3
  };

  // 環境変数からGuild IDsを取得（カンマ区切り）
  if (process.env.DISCORD_GUILD_IDS) {
    config.guildIds = process.env.DISCORD_GUILD_IDS.split(',').map(id => id.trim());
  }

  // config.jsonから設定を読み込む（環境変数で上書き可能）
  const configPath = path.join(__dirname, '..', 'config.json');
  if (fs.existsSync(configPath)) {
    const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    // 環境変数が設定されていない場合はファイルから読み込む
    if (config.guildIds.length === 0) {
      config.guildIds = fileConfig.guildIds || [];
    }
    config.keywords = fileConfig.keywords || [];
    config.excludeKeywords = fileConfig.excludeKeywords || [];
    config.checkIntervalHours = fileConfig.checkIntervalHours || 3;
  }

  return config;
}

// Discord API リクエスト
function discordRequest(path, token, method = 'GET') {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'discord.com',
      path: `/api/v10${path}`,
      method: method,
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(data);
          }
        } else {
          reject(new Error(`Discord API Error: ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.end();
  });
}

// Slack通知送信
function sendSlackNotification(webhookUrl, message) {
  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl);
    const payload = JSON.stringify(message);

    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`Slack API Error: ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(payload);
    req.end();
  });
}

// メッセージにキーワードが含まれているかチェック
function containsKeyword(content, keywords) {
  return keywords.some(keyword => content.includes(keyword));
}

// 除外キーワードが含まれているかチェック
function shouldExcludeMessage(content, excludeKeywords) {
  return excludeKeywords.some(keyword => content.includes(keyword));
}

// タイムスタンプをSnowflakeに変換（Discord IDから時刻を取得）
function snowflakeToTimestamp(snowflake) {
  const DISCORD_EPOCH = 1420070400000;
  return Number(BigInt(snowflake) >> 22n) + DISCORD_EPOCH;
}

// チャンネルを並列処理する関数
async function processChannel(channel, guildId, guildName, config, cutoffTime) {
  try {
    // メッセージ取得（最新100件）
    const messages = await discordRequest(
      `/channels/${channel.id}/messages?limit=100`,
      config.discordToken
    );

    const results = {
      channelName: channel.name,
      messageCount: messages.length,
      matches: [],
      error: null
    };

    // キーワードマッチング
    for (const message of messages) {
      // メッセージの作成時刻をチェック
      const messageTime = snowflakeToTimestamp(message.id);
      
      if (messageTime < cutoffTime) {
        continue; // 監視期間外
      }

      // キーワードチェック
      if (containsKeyword(message.content, config.keywords)) {
        // 除外キーワードチェック
        if (shouldExcludeMessage(message.content, config.excludeKeywords)) {
          continue; // 除外キーワードが含まれている場合はスキップ
        }
        
        const messageUrl = `https://discord.com/channels/${guildId}/${channel.id}/${message.id}`;
        
        results.matches.push({
          guildName,
          channelName: channel.name,
          author: message.author.username,
          content: message.content,
          messageUrl,
          messageTime
        });
      }
    }

    return results;
  } catch (error) {
    // 403エラー（アクセス権限なし）は警告として扱い、エラーカウントに含めない
    if (error.message.includes('403')) {
      return {
        channelName: channel.name,
        messageCount: 0,
        matches: [],
        error: null,  // 403エラーはnullとして扱う
        skipped: true  // スキップフラグ
      };
    }
    
    // その他のエラーは通常通り記録
    return {
      channelName: channel.name,
      messageCount: 0,
      matches: [],
      error: `${error.message}`
    };
  }
}

// サーバーを並列処理する関数
async function processGuild(guildId, guildIndex, totalGuilds, config, cutoffTime) {
  const guildStartTime = Date.now();
  
  try {
    // サーバー情報取得
    const guild = await discordRequest(`/guilds/${guildId}`, config.discordToken);
    console.log(`\n[${guildIndex + 1}/${totalGuilds}] サーバー ${guildId} (${guild.name}) を処理中...`);

    // チャンネル一覧取得
    const channels = await discordRequest(`/guilds/${guildId}/channels`, config.discordToken);
    const textChannels = channels.filter(ch => ch.type === 0); // テキストチャンネルのみ
    
    console.log(`  ✓ テキストチャンネル数: ${textChannels.length}`);

    // チャンネルを並列処理（5つずつバッチ処理）
    const BATCH_SIZE = 5;
    const allResults = [];

    for (let i = 0; i < textChannels.length; i += BATCH_SIZE) {
      const batch = textChannels.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(channel => processChannel(channel, guildId, guild.name, config, cutoffTime))
      );
      allResults.push(...batchResults);

      // 進捗表示
      const processed = Math.min(i + BATCH_SIZE, textChannels.length);
      console.log(`  処理中: ${processed}/${textChannels.length} チャンネル`);

      // レート制限対策（バッチごとに少し待機）
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    const guildEndTime = Date.now();
    const guildExecutionTime = ((guildEndTime - guildStartTime) / 1000).toFixed(2);
    console.log(`  ✓ 完了 (${guildExecutionTime}秒)`);

    return {
      guildId,
      guildName: guild.name,
      channelCount: textChannels.length,
      results: allResults,
      executionTime: guildExecutionTime,
      error: null
    };

  } catch (error) {
    console.error(`  ❌ エラー: ${error.message}`);
    return {
      guildId,
      guildName: null,
      channelCount: 0,
      results: [],
      executionTime: 0,
      error: `${error.message}`
    };
  }
}

// メインロジック
async function main() {
  const startTime = Date.now();
  console.log('='.repeat(60));
  console.log('メンションなし支払い連絡通知システム - 実行開始');
  console.log(`実行時刻: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`);
  console.log('='.repeat(60));

  // 設定読み込み
  const config = loadConfig();

  // 必須設定のチェック
  if (!config.discordToken) {
    console.error('❌ エラー: DISCORD_BOT_TOKEN が設定されていません');
    process.exit(1);
  }

  if (!config.slackWebhookUrl) {
    console.error('❌ エラー: SLACK_WEBHOOK_URL が設定されていません');
    process.exit(1);
  }

  if (config.guildIds.length === 0) {
    console.error('❌ エラー: Discord Guild IDs が設定されていません');
    process.exit(1);
  }

  console.log(`\n📊 設定情報:`);
  console.log(`  - 監視サーバー数: ${config.guildIds.length}`);
  console.log(`  - 監視キーワード数: ${config.keywords.length}`);
  console.log(`  - 除外キーワード数: ${config.excludeKeywords.length}`);
  console.log(`  - 監視期間: 過去 ${config.checkIntervalHours} 時間`);
  console.log(`  - 並列処理: 有効 (チャンネルごとに5並列)`);

  // 監視期間の計算
  const hoursAgo = config.checkIntervalHours * 60 * 60 * 1000;
  const cutoffTime = Date.now() - hoursAgo;

  console.log(`\n🔍 検索開始時刻: ${new Date(cutoffTime).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`);

  // サーバーを並列処理（3つずつ）
  const GUILD_BATCH_SIZE = 3;
  const allGuildResults = [];

  for (let i = 0; i < config.guildIds.length; i += GUILD_BATCH_SIZE) {
    const batch = config.guildIds.slice(i, i + GUILD_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((guildId, batchIndex) => 
        processGuild(guildId, i + batchIndex, config.guildIds.length, config, cutoffTime)
      )
    );
    allGuildResults.push(...batchResults);
  }

  // 結果を集計
  let totalChannels = 0;
  let totalMessages = 0;
  let matchedMessages = 0;
  let skippedChannels = 0;
  const errors = [];
  const allMatches = [];

  for (const guildResult of allGuildResults) {
    if (guildResult.error) {
      errors.push(`サーバー ${guildResult.guildId}: ${guildResult.error}`);
      continue;
    }

    totalChannels += guildResult.channelCount;

    for (const channelResult of guildResult.results) {
      totalMessages += channelResult.messageCount;
      
      // 403エラー（アクセス権限なし）はスキップとしてカウント
      if (channelResult.skipped) {
        skippedChannels++;
        continue;
      }
      
      if (channelResult.error) {
        errors.push(`チャンネル ${channelResult.channelName}: ${channelResult.error}`);
      }

      if (channelResult.matches.length > 0) {
        allMatches.push(...channelResult.matches);
        matchedMessages += channelResult.matches.length;
      }
    }
  }

  // マッチしたメッセージをSlackに通知
  for (const match of allMatches) {
    console.log(`\n  🎯 キーワード検出!`);
    console.log(`    - サーバー: ${match.guildName}`);
    console.log(`    - チャンネル: #${match.channelName}`);
    console.log(`    - 送信者: ${match.author}`);
    console.log(`    - メッセージ: ${match.content.substring(0, 50)}...`);

    // Slack通知（@channel メンション付き）
    const slackMessage = {
      text: '<!channel> 💰 支払い関連メッセージが検出されました',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '<!channel> :moneybag: *支払い関連メッセージ検出*'
          }
        },
        {
          type: 'divider'
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*サーバー:*\n${match.guildName}`
            },
            {
              type: 'mrkdwn',
              text: `*チャンネル:*\n#${match.channelName}`
            },
            {
              type: 'mrkdwn',
              text: `*送信者:*\n${match.author}`
            },
            {
              type: 'mrkdwn',
              text: `*送信時刻:*\n${new Date(match.messageTime).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`
            }
          ]
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*メッセージ:*\n${match.content}`
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `<${match.messageUrl}|:link: メッセージを開く>`
          }
        },
        {
          type: 'divider'
        }
      ]
    };

    try {
      await sendSlackNotification(config.slackWebhookUrl, slackMessage);
      console.log(`    ✓ Slack通知送信完了`);
    } catch (error) {
      console.error(`    ❌ Slack通知エラー: ${error.message}`);
    }
  }

  // 実行結果サマリー
  const endTime = Date.now();
  const executionTime = ((endTime - startTime) / 1000).toFixed(2);

  console.log('\n' + '='.repeat(60));
  console.log('📊 実行結果サマリー');
  console.log('='.repeat(60));
  console.log(`実行時間: ${executionTime}秒`);
  console.log(`監視サーバー数: ${config.guildIds.length}`);
  console.log(`監視チャンネル数: ${totalChannels}`);
  console.log(`アクセス可能チャンネル数: ${totalChannels - skippedChannels}`);
  console.log(`アクセス不可チャンネル数: ${skippedChannels} (プライベートチャンネル)`);
  console.log(`確認メッセージ数: ${totalMessages}`);
  console.log(`キーワード検出数: ${matchedMessages}`);
  console.log(`エラー数: ${errors.length}`);

  if (errors.length > 0) {
    console.log('\n⚠️  エラー詳細:');
    errors.forEach((error, index) => {
      console.log(`  ${index + 1}. ${error}`);
    });
  }

  // Slackに実行サマリーを送信（確認メッセージ数が0より多い場合のみ）
  if (totalMessages > 0) {
    const summaryBlocks = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '📊 Discord監視システム - 実行完了',
          emoji: true
        }
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*実行時間:*\n${executionTime}秒`
          },
          {
            type: 'mrkdwn',
            text: `*監視サーバー数:*\n${config.guildIds.length}`
          },
          {
            type: 'mrkdwn',
            text: `*監視チャンネル数:*\n${totalChannels}`
          },
          {
            type: 'mrkdwn',
            text: `*アクセス可能:*\n${totalChannels - skippedChannels}`
          },
          {
            type: 'mrkdwn',
            text: `*確認メッセージ数:*\n${totalMessages}`
          },
          {
            type: 'mrkdwn',
            text: `*キーワード検出数:*\n${matchedMessages} 件`
          },
          {
            type: 'mrkdwn',
            text: `*エラー数:*\n${errors.length}`
          },
          {
            type: 'mrkdwn',
            text: `*スキップ:*\n${skippedChannels} (権限なし)`
          }
        ]
      }
    ];

    // エラーがある場合、エラー詳細を追加
    if (errors.length > 0) {
      summaryBlocks.push({
        type: 'divider'
      });
      
      summaryBlocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':warning: *エラー詳細:*'
        }
      });

      // エラーを最大10件まで表示
      const errorList = errors.slice(0, 10).map((error, index) => {
        return `${index + 1}. ${error}`;
      }).join('\n');

      summaryBlocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `\`\`\`${errorList}\`\`\``
        }
      });

      if (errors.length > 10) {
        summaryBlocks.push({
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `_他 ${errors.length - 10} 件のエラーがあります。詳細はRenderログを確認してください。_`
            }
          ]
        });
      }
    }

    const summaryMessage = {
      text: '📊 Discord監視システム - 実行完了',
      blocks: summaryBlocks
    };

    await sendSlackNotification(config.slackWebhookUrl, summaryMessage);
    console.log('\n✅ Slack通知送信完了');
  } else {
    console.log('\n⏭️  確認メッセージ数が0のため、Slack通知をスキップしました');
  }
  
  console.log('✅ 実行完了');
  console.log('='.repeat(60));
}

// スクリプト実行
main().catch(error => {
  console.error('❌ 致命的なエラー:', error);
  process.exit(1);
});

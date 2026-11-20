// SE AI Digest Slack App (Slack Bolt - Node.js)
// This app allows SEs to run a slash command that:
// 1. Takes optional channel preferences
// 2. Searches Slack for new SE AI use cases
// 3. Personalizes based on prior feedback
// 4. Returns results with links + feedback collection

const { App, LogLevel } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const axios = require('axios');
const { google } = require('googleapis');

// Initialize Slack Bolt app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  logLevel: LogLevel.DEBUG
});

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

// Google Sheets setup for feedback storage
const sheets = google.sheets({
  version: 'v4',
  auth: new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_CREDENTIALS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  })
});

const FEEDBACK_SHEET_ID = process.env.FEEDBACK_SHEET_ID;
const FEEDBACK_SHEET_RANGE = 'Feedback!A:F';

// Default channels to search if user doesn't specify
const DEFAULT_CHANNELS = [
  'broadcast-solutions-builders',
  'se-design',
  'csg-proservices-applied-ai',
  'mastering-agentforce-for-solution-engineers',
  'ai-practice-agentforce-se-poc',
  'eq-wise'
];

// In-memory store for starred use cases (maps messageTs → useCase data)
const starredUseCases = {};

// Slash command: /se-ai-digest-starred (view all saved items)
app.command('/se-ai-digest-starred', async ({ ack, body, client }) => {
  await ack();

  const userId = body.user_id;
  const userEmail = body.user_email;

  try {
    // Get user's starred messages
    const result = await client.conversations.history({
      channel: userId,
      limit: 1000
    });

    const messages = result.messages || [];
    const starredItems = [];

    for (const msg of messages) {
      // Check if message has star reaction from this user
      if (msg.reactions) {
        const starReaction = msg.reactions.find(r => r.name === 'star');
        if (starReaction && starReaction.users.includes(userId)) {
          // Look up the use case data we stored
          const key = `${userId}_${msg.ts}`;
          if (starredUseCases[key]) {
            starredItems.push(starredUseCases[key]);
          }
        }
      }
    }

    if (starredItems.length === 0) {
      await client.chat.postMessage({
        channel: userId,
        text: '⭐ No starred use cases yet. React to use cases in your digest with ⭐ to save them here!'
      });
      return;
    }

    // Format and display all starred items
    const blocks = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `⭐ Your Saved Use Cases (${starredItems.length})`
        }
      },
      { type: 'divider' }
    ];

    starredItems.forEach((item, idx) => {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${idx + 1}. ${item.title}*\n*Problem:* ${item.problem}\n*Time Savings:* ${item.timeSavings}\n*How:* ${item.howItWorks}\n*Tools:* ${item.toolsUsed}\n*Posted by:* ${item.postedBy} in #${item.channel}\n\n> "${item.originalQuote}"\n\n<${item.slackLink}|View full thread>`
        }
      });
      blocks.push({ type: 'divider' });
    });

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '💡 *Tip:* Star use cases in your digest to save them. Run `/se-ai-digest-starred` anytime to view all saved items.'
      }
    });

    await client.chat.postMessage({
      channel: userId,
      blocks: blocks
    });

  } catch (error) {
    console.error('Error fetching starred use cases:', error);
    await client.chat.postMessage({
      channel: userId,
      text: '❌ Error retrieving your saved use cases. Please try again.'
    });
  }
});

// Listen for reactions (specifically star reactions)
app.event('reaction_added', async ({ event, client }) => {
  if (event.reaction === 'star') {
    // Store that this user starred this message for later lookup
    const key = `${event.user}_${event.item.ts}`;
    // The use case data will be looked up from starredUseCases when viewing
    console.log(`⭐ User ${event.user} starred message ${event.item.ts}`);
  }
});

// Slash command: /se-ai-digest
app.command('/se-ai-digest', async ({ ack, body, client }) => {
  await ack();

  // Open modal for preferences
  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'digest_preferences_modal',
        title: {
          type: 'plain_text',
          text: 'SE AI Digest'
        },
        submit: {
          type: 'plain_text',
          text: 'Generate Digest'
        },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Generate this week\'s SE AI optimization digest*\n\nOptional: Customize channels to prioritize and use cases to exclude'
            }
          },
          {
            type: 'divider'
          },
          {
            type: 'input',
            block_id: 'channels_block',
            label: {
              type: 'plain_text',
              text: 'Channels to prioritize (optional)'
            },
            element: {
              type: 'multi_conversations_select',
              action_id: 'channels_select',
              filter: {
                include: ['public']
              }
            },
            hint: {
              type: 'plain_text',
              text: 'Select channels to look at first. Leave empty to use defaults (broadcast-solutions-builders, se-design, etc.)'
            },
            optional: true
          },
          {
            type: 'input',
            block_id: 'exclude_uses_block',
            label: {
              type: 'plain_text',
              text: 'Use cases to exclude (optional)'
            },
            element: {
              type: 'plain_text_input',
              action_id: 'exclude_uses_input',
              multiline: true,
              placeholder: {
                type: 'plain_text',
                text: 'E.g., "Marketing Cloud, Customer Success tools"\nSeparate with commas. These will be de-prioritized but AI may still find related tools.'
              }
            },
            optional: true
          },
          {
            type: 'input',
            block_id: 'your_role_block',
            label: {
              type: 'plain_text',
              text: 'Your role (optional - for personalization)'
            },
            element: {
              type: 'static_select',
              action_id: 'role_select',
              options: [
                {
                  text: {
                    type: 'plain_text',
                    text: 'Sales Engineer'
                  },
                  value: 'sales_engineer'
                },
                {
                  text: {
                    type: 'plain_text',
                    text: 'Solutions Architect'
                  },
                  value: 'architect'
                },
                {
                  text: {
                    type: 'plain_text',
                    text: 'Delivery Manager'
                  },
                  value: 'delivery_manager'
                },
                {
                  text: {
                    type: 'plain_text',
                    text: 'Pre-Sales Engineer'
                  },
                  value: 'presales_engineer'
                },
                {
                  text: {
                    type: 'plain_text',
                    text: 'No preference'
                  },
                  value: 'any'
                }
              ]
            },
            optional: true
          }
        ]
      }
    });
  } catch (error) {
    console.error(error);
  }
});

// Handle modal submission
app.view('digest_preferences_modal', async ({ ack, body, view, client }) => {
  await ack();

  const userId = body.user.id;
  const userEmail = body.user.email;

  // Extract values from form
  const selectedChannels = view.state.values.channels_block.channels_select.selected_conversations || [];
  const excludeUses = view.state.values.exclude_uses_block.exclude_uses_input.value || '';
  const userRole = view.state.values.your_role_block.role_select.selected_option?.value || 'any';

  const channelsToSearch = selectedChannels.length > 0 ? selectedChannels : DEFAULT_CHANNELS;

  // Show loading message
  await client.chat.postMessage({
    channel: userId,
    text: '⏳ Generating your SE AI digest... This takes about 30 seconds.'
  });

  try {
    // Fetch Slack messages from selected channels
    const messages = await fetchRecentMessages(client, channelsToSearch, 7); // Last 7 days

    // Get prior feedback for personalization
    const priorFeedback = await getPriorFeedback(userEmail);

    // Call Claude API to analyze and personalize
    const digest = await generateDigest(messages, excludeUses, userRole, priorFeedback);

    // Post formatted digest with feedback collection
    await postDigestToUser(client, userId, digest);

  } catch (error) {
    console.error('Error generating digest:', error);
    await client.chat.postMessage({
      channel: userId,
      text: '❌ Error generating digest. Please try again or contact the admin.'
    });
  }
});

// Fetch recent messages from Slack channels
async function fetchRecentMessages(client, channelIds, daysBack = 7) {
  const messages = [];
  const oneWeekAgo = Math.floor(Date.now() / 1000) - (daysBack * 24 * 60 * 60);

  for (const channelId of channelIds) {
    try {
      const result = await client.conversations.history({
        channel: channelId,
        oldest: oneWeekAgo.toString(),
        limit: 100
      });

      // Filter for messages about AI tools (contains keywords)
      const filtered = result.messages.filter(msg => {
        const text = (msg.text || '').toLowerCase();
        return /claude|cursor|mesh|agentforce|ai|automation|tool|workflow|script|prompt/i.test(text);
      });

      messages.push(...filtered.map(msg => ({
        ...msg,
        channel: channelId,
        channelName: result.channel?.name
      })));
    } catch (error) {
      console.error(`Error fetching messages from channel ${channelId}:`, error);
    }
  }

  return messages;
}

// Get prior feedback for this user to personalize
async function getPriorFeedback(userEmail) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: FEEDBACK_SHEET_ID,
      range: FEEDBACK_SHEET_RANGE
    });

    const rows = response.data.values || [];
    const userFeedback = rows.filter(row => row[0] === userEmail);

    // Calculate preferences from feedback
    const preferences = {
      highRatedTools: [],
      preferredTopics: [],
      avoidTopics: [],
      roles: []
    };

    userFeedback.forEach(row => {
      // row format: [email, tool, rating, feedback, timestamp, tags]
      const rating = parseInt(row[2]);
      if (rating >= 4) {
        preferences.highRatedTools.push(row[1]);
      }
      if (rating <= 2) {
        preferences.avoidTopics.push(row[1]);
      }
    });

    return preferences;
  } catch (error) {
    console.error('Error fetching prior feedback:', error);
    return {};
  }
}

// Call Claude API to generate personalized digest
async function generateDigest(messages, excludeUses, userRole, priorFeedback) {
  const messageTexts = messages.map(m => ({
    text: m.text,
    timestamp: m.ts,
    channel: m.channelName,
    user: m.user,
    threadTs: m.thread_ts,
    permalink: m.permalink
  }));

  const prompt = `
You are an expert at identifying and summarizing AI productivity tools that Solution Engineers use to optimize their jobs.

Analyze the following Slack messages from SE channels and extract the TOP 3-5 NEW AI USE CASES from this week.

SLACK MESSAGES:
${JSON.stringify(messageTexts, null, 2)}

USER PREFERENCES:
- Role: ${userRole}
- Topics to exclude/de-prioritize: ${excludeUses}
- Prior high-rated tools: ${priorFeedback.highRatedTools?.join(', ') || 'None yet'}
- Topics to avoid: ${priorFeedback.avoidTopics?.join(', ') || 'None'}

FOR EACH USE CASE, EXTRACT:
1. Title (short, SE-friendly)
2. Problem (what bottleneck does it solve?)
3. Time Savings (e.g., "70-80% reduction", "20 hours → 2 hours")
4. How It Works (1-2 sentences)
5. Tools Used (Claude, Cursor, Mesh, Agentforce, etc.)
6. Posted By (person/team name)
7. Slack Thread/Post (the original message link)
8. Full Quote (2-3 sentences from the original post)

INSTRUCTIONS:
- Only include NEW findings from the past 7 days
- Prioritize tools matching the user's role (${userRole})
- De-prioritize topics they marked as exclude (${excludeUses})
- Prefer tools rated highly in prior feedback
- Avoid repeating topics they marked as "not helpful"
- Include 3-5 use cases, ranked by relevance to their role

OUTPUT AS JSON:
{
  "useCases": [
    {
      "title": "...",
      "problem": "...",
      "timeSavings": "...",
      "howItWorks": "...",
      "toolsUsed": ["Claude", "Cursor"],
      "postedBy": "...",
      "slackLink": "...",
      "originalQuote": "...",
      "channel": "..."
    }
  ],
  "summary": "One sentence on this week's trends"
}

Be thorough but concise. Return valid JSON only.
`;

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 2000,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      },
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        }
      }
    );

    const content = response.data.content[0].text;
    return JSON.parse(content);
  } catch (error) {
    console.error('Error calling Claude API:', error);
    throw error;
  }
}

// Post formatted digest to user with feedback collection
async function postDigestToUser(client, userId, digest) {
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: '🤖 SE AI Optimization Weekly Digest',
        emoji: true
      }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${digest.summary}*`
      }
    },
    {
      type: 'divider'
    }
  ];

  // Add each use case
  digest.useCases.forEach((useCase, index) => {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${index + 1}. ${useCase.title}*\n*Problem:* ${useCase.problem}\n*Time Savings:* ${useCase.timeSavings}\n*How:* ${useCase.howItWorks}\n*Tools:* ${useCase.toolsUsed.join(', ')}\n*Posted by:* ${useCase.postedBy} in #${useCase.channel}\n\n> "${useCase.originalQuote}"\n\n<${useCase.slackLink}|View full thread>\n\n_React with ⭐ to save this to your favorites_`
      }
    });

    blocks.push({
      type: 'actions',
      block_id: `feedback_${index}`,
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '👍 Helpful'
          },
          value: `helpful_${index}`,
          action_id: `feedback_helpful_${index}`
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '📌 Bookmarking'
          },
          value: `bookmark_${index}`,
          action_id: `feedback_bookmark_${index}`
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '❌ Not for me'
          },
          value: `not_relevant_${index}`,
          action_id: `feedback_not_relevant_${index}`
        }
      ]
    });

    blocks.push({
      type: 'divider'
    });
  });

  // Add feedback instructions
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '📊 *Quick Feedback* (30 seconds)\n\nClick a button to rate each use case. Your feedback helps personalize future digests!\n\nWant to add details? Click "Tell us why" below.\n\n💾 *Save for later:* React with ⭐ to any use case. View your saved items anytime with `/se-ai-digest-starred`'
    }
  });

  blocks.push({
    type: 'actions',
    block_id: 'general_actions',
    elements: [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: '💬 Tell us why'
        },
        value: 'open_feedback_modal',
        action_id: 'open_feedback_modal'
      }
    ]
  });

  const result = await client.chat.postMessage({
    channel: userId,
    blocks: blocks
  });

  // Store use case data for starred item lookup later
  digest.useCases.forEach((useCase, index) => {
    const key = `${userId}_${result.ts}`;
    starredUseCases[key] = {
      title: useCase.title,
      problem: useCase.problem,
      timeSavings: useCase.timeSavings,
      howItWorks: useCase.howItWorks,
      toolsUsed: useCase.toolsUsed.join(', '),
      postedBy: useCase.postedBy,
      channel: useCase.channel,
      originalQuote: useCase.originalQuote,
      slackLink: useCase.slackLink
    };
  });
}

// Handle feedback button clicks
app.action(/^feedback_/, async ({ ack, action, body, client }) => {
  await ack();

  const userId = body.user.id;
  const userEmail = body.user.email;
  const feedback = action.value;
  const index = action.value.split('_')[1];

  // Map feedback to rating
  const ratingMap = {
    'helpful': 5,
    'bookmark': 3,
    'not_relevant': 1
  };

  const rating = ratingMap[action.value.split('_')[0]];

  // Store in Google Sheets
  await storeFeedback(userEmail, body.actions[index]?.value || 'Unknown', rating, feedback);

  await client.chat.postEphemeral({
    channel: userId,
    user: userId,
    text: `✅ Thanks for your feedback! Your preferences help shape future digests.`
  });
});

// Handle "Tell us why" button
app.action('open_feedback_modal', async ({ ack, body, client }) => {
  await ack();

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'feedback_details_modal',
      title: {
        type: 'plain_text',
        text: 'Feedback'
      },
      submit: {
        type: 'plain_text',
        text: 'Submit'
      },
      blocks: [
        {
          type: 'input',
          block_id: 'tool_interest_block',
          label: {
            type: 'plain_text',
            text: 'Which tool interested you most?'
          },
          element: {
            type: 'plain_text_input',
            action_id: 'tool_interest_input',
            placeholder: {
              type: 'plain_text',
              text: 'E.g., "ScopeZilla"'
            }
          }
        },
        {
          type: 'input',
          block_id: 'feedback_text_block',
          label: {
            type: 'plain_text',
            text: 'Why? (Optional)'
          },
          element: {
            type: 'plain_text_input',
            action_id: 'feedback_text_input',
            multiline: true,
            placeholder: {
              type: 'plain_text',
              text: 'E.g., "Solves our exact problem" or "Team already using this"'
            }
          },
          optional: true
        },
        {
          type: 'input',
          block_id: 'topic_request_block',
          label: {
            type: 'plain_text',
            text: 'Topic for next week? (Optional)'
          },
          element: {
            type: 'plain_text_input',
            action_id: 'topic_request_input',
            placeholder: {
              type: 'plain_text',
              text: 'E.g., "Cursor advanced workflows"'
            }
          },
          optional: true
        }
      ]
    }
  });
});

// Store feedback in Google Sheets
async function storeFeedback(userEmail, tool, rating, feedback, details = {}) {
  try {
    const timestamp = new Date().toISOString();
    const tags = details.tags || '';

    await sheets.spreadsheets.values.append({
      spreadsheetId: FEEDBACK_SHEET_ID,
      range: FEEDBACK_SHEET_RANGE,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [
          [userEmail, tool, rating, feedback, timestamp, tags]
        ]
      }
    });
  } catch (error) {
    console.error('Error storing feedback:', error);
  }
}

// Start the app
(async () => {
  await app.start();
  console.log('⚡️ SE AI Digest app is running!');
})();

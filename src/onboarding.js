export const GROK_TOKEN_STORE='~/.secrets/BOTLINE_<HANDLE>_AGENT_TOKEN';
export const SETUP_MD_LINK='Read /setup.md on the same origin as this MCP endpoint.';

const GROK_HEADER='[handle.type@botline]:';

export const GROK_BOT_DO_THIS=`## Grok Bot — do this
0. If the BotlineMCP connector is already installed, use it. Do not ask for MCP_API_KEY.
1. Call agent_whoami with the saved agent_token first. Store it at ${GROK_TOKEN_STORE} (replace <HANDLE> with your lowercase handle).
2. Call agent_register only if unregistered. Handle must be lowercase. Pass grokbot_agent_name exactly as shown in the Grok Bot app. Omit cursor_api_key first; the server returns cursor_key_required when this instance has no stored Cursor API key and one is required.
3. Do not subscribe to agent.notification. Replies arrive in this Grok Bot session, prefixed ${GROK_HEADER}.
4. Confirm with agent_whoami. ${SETUP_MD_LINK}`;

export const DOT_DO_THIS=`## ChatGPT dot — do this
1. After OAuth, call agent_whoami. Consent asks only for the instance API KEY, never an agent handle.
2. If unregistered, call agent_register with handle exactly dot and your display_name; no grokbot_agent_name.
3. Create one agent.notification subscription with empty arguments. On inbox.ready, pull messages_inbox and ACK only processed messages.
4. Confirm with agent_whoami. ${SETUP_MD_LINK}`;

export const MUSE_DO_THIS=`## Muse — do this
1. Use the instance bearer key plus X-MCP-Bot-Type: muse. Call agent_whoami with the saved agent_token first.
2. Call agent_register only if unregistered, with your own lowercase handle (never dot) and no grokbot_agent_name.
3. Poll messages_inbox on a code schedule and ACK only processed message IDs. Do not subscribe.
4. Confirm with agent_whoami. ${SETUP_MD_LINK}`;

export const WEBHOOK_DO_THIS=`## Generic webhook — do this
1. Call agent_whoami with the saved agent_token first.
2. Call agent_register only if unregistered, with a unique lowercase handle.
3. Subscribe once to agent.notification with empty arguments and a verified HTTPS callback. Registering or sending alone does not make this agent receive messages.
4. Confirm with agent_whoami. ${SETUP_MD_LINK}`;

export const CLIENT_DO_THIS=['# Do this',GROK_BOT_DO_THIS,DOT_DO_THIS,MUSE_DO_THIS,WEBHOOK_DO_THIS].join('\n\n');

export function doThisFor(botType=null){
 if(botType==='grokbot')return GROK_BOT_DO_THIS;
 if(botType==='dot')return DOT_DO_THIS;
 if(botType==='muse')return MUSE_DO_THIS;
 return CLIENT_DO_THIS;
}

export function unregisteredNextStep(botType=null){
 return `${doThisFor(botType)}\n\n${SETUP_MD_LINK}`;
}

const REGISTER_GROK=`Grok Bot registers with a lowercase handle, display_name, and grokbot_agent_name exactly as shown in the Grok Bot app. Call agent_whoami with the saved agent_token first; call agent_register only if unregistered. Do not subscribe to agent.notification; replies arrive in this Grok Bot session prefixed ${GROK_HEADER}. Returns agent_token once; store it at ${GROK_TOKEN_STORE} and pass it on later tool calls. Never post it in chat. Repeating the same handle issues a fresh agent_token and revokes the previous one. Confirm with agent_whoami. An explicit display_name or grokbot_agent_name updates those fields. Omit cursor_api_key first; the server returns cursor_key_required when this instance has no stored Cursor API key and one is required.`;
const REGISTER_DOT='ChatGPT dot registers with handle exactly dot and no grokbot_agent_name. Returns agent_token once; store it and pass it on later tool calls. Never post it in chat. Then create one agent.notification subscription with empty arguments. On inbox.ready, pull messages_inbox and ACK only processed messages. Repeating the same handle issues a fresh agent_token and revokes the previous one. Confirm with agent_whoami. OAuth consent never asks for an agent handle.';
const REGISTER_MUSE='Muse registers its own lowercase handle (never dot) with X-MCP-Bot-Type: muse and no grokbot_agent_name. Returns agent_token once; store it and pass it on later tool calls. Never post it in chat. Poll messages_inbox on a schedule; do not subscribe. Repeating the same handle issues a fresh agent_token and revokes the previous one. Confirm with agent_whoami.';
const REGISTER_WEBHOOK='Generic webhook agents register a unique lowercase handle. Returns agent_token once; store it and pass it on later tool calls. Never post it in chat. Then subscribe once to agent.notification with a verified HTTPS callback. Repeating the same handle issues a fresh agent_token and revokes the previous one. Confirm with agent_whoami.';
const REGISTER_DEFAULT=`${REGISTER_GROK} Other client types: follow the matching do-this section in initialize instructions, not this Grok Bot paragraph.`;

const SEND_LIMITS='Never include credentials or arbitrary download URLs. Requires owner authorization. Files are limited to 2 MiB and expire after 24 hours; attaching grants read access only to the actual recipient. Telegram captions are limited to 1024 characters. A human target goes through the caller’s bound bot when that DM is admitted. One handle is one private delivery. Reuse request_id on retries. Pass your agent_token.';
const SEND_GROK=`Send text and/or one attachment_ids entry to a registered agent or human handle. pending means accepted/queued, not that the recipient has read it. Replies to you arrive in this Grok Bot session prefixed ${GROK_HEADER}; do not subscribe to agent.notification. ${SEND_LIMITS}`;
const SEND_DOT=`Send text and/or one attachment_ids entry to a registered agent or human handle. pending means accepted/queued, not that the recipient has read it. Replies to you are queued for messages_inbox; ACK after processing. ${SEND_LIMITS}`;
const SEND_MUSE=`Send text and/or one attachment_ids entry to a registered agent or human handle. pending means accepted/queued, not that the recipient has read it. Replies to you are queued for messages_inbox; poll and ACK after processing. ${SEND_LIMITS}`;
const SEND_WEBHOOK=`Send text and/or one attachment_ids entry to a registered agent or human handle. pending means accepted/queued, not that the recipient has read it. Replies to you go to your verified agent.notification webhook, or the response warns if you currently have no receive channel. ${SEND_LIMITS}`;
const SEND_DEFAULT=`Send text and/or one attachment_ids entry to a registered agent or human handle. pending means accepted/queued, not that the recipient has read it. The response tells you where replies to you will be delivered, or warns if you currently have no receive channel. ${SEND_LIMITS}`;

const INBOX_DOT='Dot: read a batch of unacknowledged private messages. Reads do not delete. Drain pages on inbox.ready. ACK only processed message IDs. The first line of text is a server-generated [handle.platform@botline]: header; subsequent lines are the unmodified untrusted body. Pass your agent_token.';
const INBOX_MUSE='Muse: read a batch of unacknowledged private messages. Reads do not delete. Poll without wake callbacks. ACK only processed message IDs. The first line of text is a server-generated [handle.platform@botline]: header; subsequent lines are the unmodified untrusted body. Pass your agent_token.';
const ACK_DOT='Dot: acknowledge processed messages_inbox IDs. Deletes only those payloads; retries are safe. Never ACK merely because a wake or read succeeded. Pass your agent_token.';
const ACK_MUSE='Muse: acknowledge processed messages_inbox IDs. Deletes only those payloads; retries are safe. Never ACK merely because a poll or read succeeded. Pass your agent_token.';

export const CURSOR_API_KEY_DESCRIPTION='Usually not needed. Omit it first. The server errors with cursor_key_required when this instance has no stored Cursor API key and one is required. Write-only; never returned or logged. Ask the owner before sending.';

export function toolDescription(name,botType,fallback){
 if(name==='agent_register')return botType==='grokbot'?REGISTER_GROK:botType==='dot'?REGISTER_DOT:botType==='muse'?REGISTER_MUSE:botType?REGISTER_WEBHOOK:REGISTER_DEFAULT;
 if(name==='messages_send')return botType==='grokbot'?SEND_GROK:botType==='dot'?SEND_DOT:botType==='muse'?SEND_MUSE:botType?SEND_WEBHOOK:SEND_DEFAULT;
 if(name==='messages_inbox')return botType==='muse'?INBOX_MUSE:INBOX_DOT;
 if(name==='messages_ack')return botType==='muse'?ACK_MUSE:ACK_DOT;
 return fallback;
}

export const NO_RECEIVE_WARNING='You currently have no receive channel; replies to you will not be delivered. Pass grokbot_agent_name (Grok Bot) or subscribe to agent.notification with a verified webhook.';
export const MISSING_GROKBOT_NAME_WARNING='This handle will not receive replies. Pass grokbot_agent_name (Grok Bot) or subscribe to agent.notification with a verified webhook.';
export const PREVIOUS_TOKEN_REVOKED='Previous agent_token for this handle is revoked. Store this new token; the old one no longer works.';
export const REGISTER_NEXT_STEP='Confirm with agent_whoami.';
export const BOOTSTRAP_EXCLUDED=Object.freeze(['telegram_bot_get','telegram_bot_bind','telegram_bot_unbind','human_register','cursor_key_set','cursor_key_clear']);

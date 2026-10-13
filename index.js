require('dotenv').config();
const { 
  Client, 
  GatewayIntentBits, 
  EmbedBuilder, 
  Events, 
  MessageFlags, 
  PermissionFlagsBits 
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const { createControlPanel, createLogMessage, createRegisterModal, createAutoMessageModal, DEFAULT_PANEL_CONFIG } = require('./src/ui');
const BotManager = require('./src/BotManager');
const { buildHelpHome, buildGuide, handleHelpInteraction } = require('./src/help');

// Custom Emojis (defined in src/emojis.js)
const { E } = require('./src/emojis');
const EMOJI_CHECK       = E.CHECK;
const EMOJI_CROSS       = E.CROSS;
const EMOJI_WARN        = E.WARN;
const EMOJI_INFO        = E.INFO;
const EMOJI_STATUS_UP   = E.STATUS_UP;
const EMOJI_DELETE      = E.DELETE;
const EMOJI_START       = E.START;
const EMOJI_RESTART     = E.RESTART;
const EMOJI_STOP        = E.STOP;

// Validate environment variables
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN || TOKEN.trim() === '') {
  console.error('[CypherX AFK] ERROR: DISCORD_TOKEN is missing in environment variables (.env or Startup Panel)!');
  process.exit(1);
}

// Initialize Discord Client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const MAX_SLOTS = parseInt(process.env.MAX_BOT_SLOTS || '70', 10);
const manager = new BotManager(MAX_SLOTS);

let activePanelMessage = null;
let prefix = ',';
let logChannelId = process.env.LOG_CHANNEL_ID ? process.env.LOG_CHANNEL_ID.replace(/\D/g, '') : null;
let customGuideText = 
  '1. Admins will spawn the AFK Bot Panel below.\n' +
  '2. Click **Register** and specify whether your server requires Login/Register (`yes` or `no`).\n' +
  '3. Ensure your server is **Online** and **Cracked** option is turned ON.\n' +
  '4. Click **Start** to connect your AFK bot to the server.\n' +
  '5. Press **Grind Mode** to fight mobs, **Auto Chop** to chop trees, or use `,gather` / `,craft`.\n' +
  '6. If the server has a login system, the bot **registers automatically** on first join and **logs in automatically** every time it reconnects!';

const startTime = Date.now();

function isAuthorAdmin(message) {
  return message.member.permissions.has(PermissionFlagsBits.Administrator) || manager.isAdmin(message.author.id);
}

// ---------- Panel customization (thumbnail / banner image / color / style) ----------
const CONFIG_FILE = path.join(__dirname, 'panel-config.json');
const ASSET_DIR = path.join(__dirname, 'assets');

let panelConfig = { ...DEFAULT_PANEL_CONFIG };
try {
  if (fs.existsSync(CONFIG_FILE)) {
    panelConfig = { ...DEFAULT_PANEL_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  }
} catch (err) {
  console.error('[Panel Config] Could not load panel-config.json:', err.message);
}

function savePanelConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(panelConfig, null, 2));
  } catch (err) {
    console.error('[Panel Config] Could not save panel-config.json:', err.message);
  }
}

function buildPanel() {
  const fallbackThumbnail = client.user ? client.user.displayAvatarURL({ extension: 'png', size: 256 }) : null;
  return createControlPanel(manager.getActiveCount(), manager.getAvailableSlots(), 'Online', { ...panelConfig, fallbackThumbnail });
}

function isHttpUrl(value) {
  return /^https?:\/\/\S+$/i.test(value || '');
}

function clearAsset(kind) {
  const current = panelConfig[kind];
  if (current && current.type === 'file' && current.path) {
    try { fs.unlinkSync(current.path); } catch (_) {}
  }
  panelConfig[kind] = null;
}

// Downloads an uploaded image so it never expires (Discord CDN links do expire)
async function saveUploadedImage(kind, url, contentType) {
  const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' })[contentType];
  if (!ext) throw new Error('Only PNG, JPG, GIF or WEBP images are supported.');

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) throw new Error('Image is larger than 8 MB.');

  fs.mkdirSync(ASSET_DIR, { recursive: true });
  clearAsset(kind);
  const name = `${kind}-${Date.now()}.${ext}`;
  const filePath = path.join(ASSET_DIR, name);
  fs.writeFileSync(filePath, buf);
  panelConfig[kind] = { type: 'file', path: filePath, name };
}

// Re-render the live panel; if it cannot be edited in place (old style), post a fresh one
async function applyPanelChange(channel) {
  savePanelConfig();
  if (activePanelMessage) {
    try {
      await activePanelMessage.edit(buildPanel());
      return true;
    } catch (err) {
      console.error('[Panel Update] In-place edit failed, sending a new panel:', err.message);
    }
  }
  if (channel) {
    activePanelMessage = await channel.send(buildPanel());
    return true;
  }
  return false;
}

async function refreshPanel() {
  if (!activePanelMessage) return;

  try {
    // Stat refreshes don't re-upload images: attachments already on the message are kept
    const { files, ...payload } = buildPanel();
    try {
      await activePanelMessage.edit(payload);
    } catch (_) {
      await activePanelMessage.edit({ ...payload, files }); // retry with images attached
    }
  } catch (err) {
    console.error('[Panel Refresh Error]', err.message);
  }
}

manager.setUpdatePanelCallback(refreshPanel);

async function sendLog(data) {
  if (!logChannelId) return;

  try {
    const channel = await client.channels.fetch(logChannelId);
    if (!channel) return;

    const action = data.action || '';

    if (/Joined|Disconnected|Died|Creeper|Auto |Grind|Task/.test(action)) {
      // Same thumbnail / color / style as the control panel
      const fallbackThumbnail = client.user ? client.user.displayAvatarURL({ extension: 'png', size: 256 }) : null;
      await channel.send(createLogMessage(data, { ...panelConfig, fallbackThumbnail }));
    }
  } catch (err) {
    console.error('[Logger Error]', err.message);
  }
}

manager.setLogCallback(sendLog);

// Context used by the help menu (read live so prefix/avatar changes show up immediately)
function getHelpContext() {
  const thumb = panelConfig.thumbnail && panelConfig.thumbnail.type === 'url' ? panelConfig.thumbnail.value : null;
  return {
    prefix,
    clientId: client.user ? client.user.id : process.env.CLIENT_ID,
    thumbnailUrl: thumb || (client.user ? client.user.displayAvatarURL({ extension: 'png', size: 256 }) : null),
    supportUrl: process.env.SUPPORT_URL
  };
}

// Ready Event
client.once(Events.ClientReady, (c) => {
  console.log(`[CypherX AFK] Logged in as ${c.user.tag}`);
});

// Prefix Commands Handling
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // Handle "?remove slot {@user} {number of slots}" (ADMIN ONLY)
  if (message.content.toLowerCase().startsWith(`${prefix}remove slot`)) {
    if (!isAuthorAdmin(message)) {
      return message.reply(`${EMOJI_CROSS} Admin permissions required to use this command.`);
    }

    const args = message.content.slice(`${prefix}remove slot`.length).trim().split(/ +/);
    
    const targetUser = message.mentions.users.first();
    const countArg = args.find(arg => !isNaN(parseInt(arg, 10)) && !arg.includes('<@'));
    const slotsToRemove = parseInt(countArg, 10);

    if (!targetUser || isNaN(slotsToRemove) || slotsToRemove < 1) {
      return message.reply(`${EMOJI_CROSS} **Usage:** \`${prefix}remove slot {@user} {number of slots}\` (e.g., \`${prefix}remove slot @SpookyMob 5\`)`);
    }

    const currentMax = manager.getUserMaxSlots(targetUser.id);
    const newMax = Math.max(1, currentMax - slotsToRemove);

    manager.setUserSlots(targetUser.id, newMax);
    return message.channel.send(`${EMOJI_CHECK} Removed **${slotsToRemove}** bot slot(s) from ${targetUser}. Total allowed bot slot(s): **${newMax}**.`);
  }

  // Filter out any messages that do not begin with the general prefix
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // ?slots <@user>
  if (command === 'slots') {
    const targetUser = message.mentions.users.first() || message.author;
    const maxSlots = manager.getUserMaxSlots(targetUser.id);
    const usedSlots = manager.getUserSlotUsage(targetUser.id);

    const slotsEmbed = new EmbedBuilder()
      .setTitle(`${EMOJI_INFO} Bot Slot Allowance`)
      .setColor(0x5865F2)
      .setDescription(`Slot details for ${targetUser}:`)
      .addFields(
        { name: 'Used Slots', value: `\`${usedSlots}\``, inline: true },
        { name: 'Max Allowed Slots', value: `\`${maxSlots}\``, inline: true }
      )
      .setTimestamp();

    return message.channel.send({ embeds: [slotsEmbed] });
  }

  // ?addslot @user <slots>
  if (command === 'addslot') {
    if (!isAuthorAdmin(message)) {
      return message.reply(`${EMOJI_CROSS} Admin permissions required.`);
    }

    const targetUser = message.mentions.users.first();
    const extraSlots = parseInt(args[1], 10);

    if (!targetUser || isNaN(extraSlots) || extraSlots < 1) {
      return message.reply(`${EMOJI_WARN} Usage: \`${prefix}addslot <@user> <total_slots>\` (e.g. \`${prefix}addslot @User 3\`)`);
    }

    const currentMax = manager.getUserMaxSlots(targetUser.id);
    const newMax = currentMax + extraSlots;

    manager.setUserSlots(targetUser.id, newMax);
    return message.channel.send(`${EMOJI_CHECK} Granted **${extraSlots}** extra bot slot(s) to ${targetUser}. Total allowed bot slot(s): **${newMax}**.`);
  }

  // ?help  (container menu with module dropdown)
  if (command === 'help') {
    return message.channel.send({
      ...buildHelpHome(getHelpContext(), message.author.id),
      allowedMentions: { parse: [] }
    });
  }

  // ?panel (RESTRICTED TO ADMINS ONLY)
  if (command === 'panel') {
    if (!isAuthorAdmin(message)) {
      return message.reply(`${EMOJI_CROSS} Only server administrators can spawn the bot panel.`);
    }

    activePanelMessage = await message.channel.send(buildPanel());
    return;
  }

  // ?setthumbnail <url> (or attach an image)   |   ?setimage <url> (or attach an image)
  if (command === 'setthumbnail' || command === 'setimage') {
    if (!isAuthorAdmin(message)) {
      return message.reply(`${EMOJI_CROSS} Only administrators can customize the panel.`);
    }
    const kind = command === 'setthumbnail' ? 'thumbnail' : 'image';
    const attachment = message.attachments.first();
    const urlArg = args[0];

    try {
      if (attachment) {
        await saveUploadedImage(kind, attachment.url, attachment.contentType);
      } else if (isHttpUrl(urlArg)) {
        clearAsset(kind);
        panelConfig[kind] = { type: 'url', value: urlArg };
      } else {
        return message.reply(`${EMOJI_WARN} **Usage:** \`${prefix}${command} <image url>\` or attach an image to the message.`);
      }
    } catch (err) {
      return message.reply(`${EMOJI_CROSS} ${err.message}`);
    }

    await applyPanelChange(message.channel);
    return message.channel.send(`${EMOJI_CHECK} Panel **${kind}** updated!`);
  }

  // ?removethumbnail | ?removeimage
  if (command === 'removethumbnail' || command === 'removeimage') {
    if (!isAuthorAdmin(message)) {
      return message.reply(`${EMOJI_CROSS} Only administrators can customize the panel.`);
    }
    clearAsset(command === 'removethumbnail' ? 'thumbnail' : 'image');
    await applyPanelChange(message.channel);
    return message.channel.send(`${EMOJI_CHECK} Panel ${command === 'removethumbnail' ? 'thumbnail' : 'banner image'} removed.`);
  }

  // ?chop [count]  |  ?gather <block> [count]  |  ?craft <item> [count]  |  ?stoptask
  if (command === 'chop') {
    const n = parseInt(args[0], 10);
    const res = manager.setTask(message.author.id, { type: 'wood', count: isNaN(n) ? 0 : n, auto: isNaN(n) });
    return message.reply(res.message);
  }

  if (command === 'gather') {
    if (args.length === 0) return message.reply(`${EMOJI_WARN} **Usage:** \`${prefix}gather <block> [count]\` (e.g. \`${prefix}gather stone 64\`)`);
    let count = 0;
    if (/^\d+$/.test(args[args.length - 1]) && args.length > 1) count = parseInt(args.pop(), 10);
    const res = manager.setTask(message.author.id, { type: 'gather', block: args.join('_'), count });
    return message.reply(res.message);
  }

  if (command === 'craft') {
    if (args.length === 0) return message.reply(`${EMOJI_WARN} **Usage:** \`${prefix}craft <item> [count]\` (e.g. \`${prefix}craft oak_planks 64\`)`);
    let count = 1;
    if (/^\d+$/.test(args[args.length - 1]) && args.length > 1) count = parseInt(args.pop(), 10);
    const res = manager.setTask(message.author.id, { type: 'craft', item: args.join('_'), count });
    return message.reply(res.message);
  }

  if (command === 'stoptask') {
    const res = manager.stopTask(message.author.id);
    return message.reply(res.message);
  }

  // ?setcolor <hex>
  if (command === 'setcolor') {
    if (!isAuthorAdmin(message)) {
      return message.reply(`${EMOJI_CROSS} Only administrators can customize the panel.`);
    }
    const hex = (args[0] || '').trim();
    if (!/^#?[0-9a-f]{6}$/i.test(hex)) {
      return message.reply(`${EMOJI_WARN} **Usage:** \`${prefix}setcolor #5865F2\``);
    }
    panelConfig.color = hex.startsWith('#') ? hex : `#${hex}`;
    await applyPanelChange(message.channel);
    return message.channel.send(`${EMOJI_CHECK} Panel color set to **${panelConfig.color}**.`);
  }

  // ?panelstyle v2|embed
  if (command === 'panelstyle') {
    if (!isAuthorAdmin(message)) {
      return message.reply(`${EMOJI_CROSS} Only administrators can customize the panel.`);
    }
    const style = (args[0] || '').toLowerCase();
    if (style !== 'v2' && style !== 'embed') {
      return message.reply(`${EMOJI_WARN} **Usage:** \`${prefix}panelstyle v2\` (container) or \`${prefix}panelstyle embed\`.`);
    }
    panelConfig.mode = style;
    await applyPanelChange(message.channel);
    return message.channel.send(`${EMOJI_CHECK} Panel style set to **${style}**.`);
  }

  // ?uptime
  if (command === 'uptime') {
    const totalSeconds = Math.floor((Date.now() - startTime) / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return message.channel.send(`${EMOJI_STATUS_UP} **Uptime:** \`${days}d ${hours}h ${minutes}m ${seconds}s\``);
  }

  // ?guide
  if (command === 'guide') {
    if (args[0] && args[0].toLowerCase() === 'edit') {
      if (!isAuthorAdmin(message)) {
        return message.reply(`${EMOJI_CROSS} You need Admin permissions to edit the guide.`);
      }
      const newGuide = args.slice(1).join(' ');
      if (!newGuide) return message.reply(`${EMOJI_WARN} Please provide new guide content.`);

      customGuideText = newGuide;
      return message.channel.send(`${EMOJI_CHECK} **Guide text updated successfully!**`);
    }

    return message.channel.send({
      ...buildGuide(customGuideText, getHelpContext(), message.author.id),
      allowedMentions: { parse: [] }
    });
  }

  // ?delregbot
  if (command === 'delregbot') {
    let targetId = message.author.id;

    if (message.mentions.users.first()) {
      if (!isAuthorAdmin(message)) {
        return message.reply(`${EMOJI_CROSS} You need Admin permissions to delete another user's bot.`);
      }
      targetId = message.mentions.users.first().id;
    }

    const result = manager.deleteBot(targetId);
    return message.reply(result.message);
  }

  // ?startall
  if (command === 'startall') {
    if (!isAuthorAdmin(message)) {
      return message.reply(`${EMOJI_CROSS} Admin permissions required.`);
    }
    const startedCount = manager.startAll();
    return message.channel.send(`${EMOJI_START} Started **${startedCount}** offline bot(s).`);
  }

  // ?stopall
  if (command === 'stopall') {
    if (!isAuthorAdmin(message)) {
      return message.reply(`${EMOJI_CROSS} Admin permissions required.`);
    }
    const stoppedCount = manager.stopAll();
    return message.channel.send(`${EMOJI_STOP} Stopped **${stoppedCount}** active bot(s).`);
  }

  // ?deloffline
  if (command === 'deloffline') {
    if (!isAuthorAdmin(message)) {
      return message.reply(`${EMOJI_CROSS} Admin permissions required.`);
    }
    const deletedCount = manager.deleteOffline();
    return message.channel.send(`${EMOJI_DELETE} Deleted **${deletedCount}** offline bot registration(s).`);
  }

  // ?allstatus
  if (command === 'allstatus') {
    if (!isAuthorAdmin(message)) {
      return message.reply(`${EMOJI_CROSS} Admin permissions required.`);
    }
    const statusList = manager.getAllBotsStatus();
    const embed = new EmbedBuilder()
      .setTitle(`${EMOJI_STATUS_UP} All Registered Bots Status`)
      .setColor(0x5865F2)
      .setDescription(statusList)
      .setTimestamp();

    return message.channel.send({ embeds: [embed] });
  }

  // ?admin <add|remove|list>
  if (command === 'admin') {
    if (!isAuthorAdmin(message)) {
      return message.reply(`${EMOJI_CROSS} Admin permissions required.`);
    }

    const sub = args[0] ? args[0].toLowerCase() : '';

    if (sub === 'add') {
      const targetUser = message.mentions.users.first();
      if (!targetUser) return message.reply(`${EMOJI_WARN} Please mention a user to add as admin.`);
      
      const added = manager.addAdmin(targetUser.id);
      return message.channel.send(added 
        ? `${EMOJI_CHECK} Added ${targetUser} as a bot admin.` 
        : `${EMOJI_WARN} User ${targetUser} is already an admin.`
      );
    }

    if (sub === 'remove') {
      const targetUser = message.mentions.users.first();
      if (!targetUser) return message.reply(`${EMOJI_WARN} Please mention a user to remove from admins.`);

      const removed = manager.removeAdmin(targetUser.id);
      return message.channel.send(removed 
        ? `${EMOJI_CHECK} Removed ${targetUser} from bot admins.` 
        : `${EMOJI_WARN} User ${targetUser} was not an admin.`
      );
    }

    if (sub === 'list') {
      const list = manager.getAdmins();
      if (list.length === 0) return message.channel.send(`${EMOJI_INFO} No custom admins assigned.`);

      const adminMentions = list.map(id => `<@${id}>`).join(', ');
      return message.channel.send(`👑 **Bot Admins:** ${adminMentions}`);
    }

    return message.reply(`${EMOJI_WARN} Usage: \`${prefix}admin <add|remove|list>\``);
  }

  // ?setprefix
  if (command === 'setprefix') {
    if (!isAuthorAdmin(message)) {
      return message.reply(`${EMOJI_CROSS} Admin permissions required.`);
    }
    const newPrefix = args[0];
    if (!newPrefix) return message.reply(`${EMOJI_WARN} Please specify a new prefix.`);

    prefix = newPrefix;
    return message.channel.send(`${EMOJI_CHECK} Prefix updated to \`${prefix}\``);
  }

  // ?setstatus
  if (command === 'setstatus') {
    if (!isAuthorAdmin(message)) {
      return message.reply(`${EMOJI_CROSS} Admin permissions required.`);
    }
    const statusText = args.join(' ');
    if (!statusText) return message.reply(`${EMOJI_WARN} Please provide status text.`);

    client.user.setActivity(statusText);
    return message.channel.send(`${EMOJI_CHECK} Status set to: **${statusText}**`);
  }

  // ?setlogchannel
  if (command === 'setlogchannel') {
    if (!isAuthorAdmin(message)) {
      return message.reply(`${EMOJI_CROSS} Admin permissions required.`);
    }
    const channel = message.mentions.channels.first() || client.channels.cache.get(args[0]);
    if (!channel) return message.reply(`${EMOJI_WARN} Please tag or provide a valid channel ID.`);

    logChannelId = channel.id.replace(/\D/g, '');
    return message.channel.send(`${EMOJI_CHECK} Log channel bound to ${channel}`);
  }
});

// BUTTON & MODAL INTERACTIONS
async function handleInteraction(interaction) {
  // Help menu dropdown / Close button (must run before the panel-message tracking below)
  if (await handleHelpInteraction(interaction, getHelpContext)) return;

  const userId = interaction.user.id;

  if (interaction.message) {
    activePanelMessage = interaction.message;
  }

  if (interaction.isButton()) {
    const customId = interaction.customId;

    switch (customId) {
      case 'btn_register':
        const userMax = manager.getUserMaxSlots(userId);
        const userCurrent = manager.getUserSlotUsage(userId);

        if (!manager.isAdmin(userId) && userCurrent >= userMax) {
          return await interaction.reply({ 
            content: `${EMOJI_CROSS} You have reached your limit of **${userMax}** slot(s). Contact an admin for extra slots!`, 
            flags: MessageFlags.Ephemeral 
          });
        }
        if (manager.getAvailableSlots() <= 0) {
          return await interaction.reply({ content: `${EMOJI_CROSS} No global slots available.`, flags: MessageFlags.Ephemeral });
        }
        await interaction.showModal(createRegisterModal());
        break;

      case 'btn_start':
        const startRes = manager.startBot(userId);
        await interaction.reply({ content: startRes.message, flags: MessageFlags.Ephemeral });
        break;

      case 'btn_stop':
        const stopRes = manager.stopBot(userId);
        await interaction.reply({ content: stopRes.message, flags: MessageFlags.Ephemeral });
        break;

      case 'btn_restart':
        const restartRes = manager.restartBot(userId);
        await interaction.reply({ content: restartRes.message, flags: MessageFlags.Ephemeral });
        break;

      case 'btn_msg_config':
        const userBots = Array.from(manager.bots.values()).filter(bot => bot.ownerId === userId);
        if (userBots.length === 0) {
          return await interaction.reply({ content: `${EMOJI_WARN} No bot registered. Please register first.`, flags: MessageFlags.Ephemeral });
        }
        const sampleBot = userBots[0];
        await interaction.showModal(createAutoMessageModal(sampleBot.autoChatMessage, sampleBot.autoChatIntervalMinutes));
        break;

      case 'btn_msg_toggle':
        const toggleRes = manager.toggleAutoMessage(userId);
        await interaction.reply({ content: toggleRes.message, flags: MessageFlags.Ephemeral });
        break;

      case 'btn_chop':
        const chopRes = manager.toggleChop(userId);
        await interaction.reply({ content: chopRes.message, flags: MessageFlags.Ephemeral });
        break;

      case 'btn_combat':
        const combatRes = manager.toggleCombat(userId);
        await interaction.reply({ content: combatRes.message, flags: MessageFlags.Ephemeral });
        break;

      case 'btn_status':
        const statusRes = manager.getStatus(userId);
        await interaction.reply({ content: statusRes.message, flags: MessageFlags.Ephemeral });
        break;

      case 'btn_delete':
        const delRes = manager.deleteBot(userId);
        await interaction.reply({ content: delRes.message, flags: MessageFlags.Ephemeral });
        break;
    }
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'modal_register') {
      const username = interaction.fields.getTextInputValue('reg_username');
      const serverAddress = interaction.fields.getTextInputValue('reg_server');
      const authInput = interaction.fields.getTextInputValue('reg_use_auth').toLowerCase().trim();
      const password = interaction.fields.getTextInputValue('reg_password') || null;
      const version = interaction.fields.getTextInputValue('reg_version') || '26.1.2';

      const useAuthPlugin = authInput === 'yes' || authInput === 'y' || authInput === 'true';

      const regRes = manager.registerBot(userId, username, serverAddress, password, useAuthPlugin, version);
      await interaction.reply({ content: regRes.message, flags: MessageFlags.Ephemeral });
    }

    if (interaction.customId === 'modal_automessage') {
      const text = interaction.fields.getTextInputValue('msg_text');
      const interval = interaction.fields.getTextInputValue('msg_interval');

      const msgRes = manager.setAutoMessage(userId, text, interval);
      await interaction.reply({ content: msgRes.message, flags: MessageFlags.Ephemeral });
    }
  }
}

// Interactions can expire (Discord only allows 3 seconds to answer) or be answered twice,
// e.g. when two copies of the bot are running. Never let that crash the process.
const IGNORABLE_DISCORD_ERRORS = new Set([10062, 40060, 10008]); // unknown interaction / already acknowledged / unknown message

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    await handleInteraction(interaction);
  } catch (err) {
    if (IGNORABLE_DISCORD_ERRORS.has(err.code)) {
      console.warn(`[Interaction] Ignored expired/duplicate interaction (${err.code}).`);
      return;
    }
    console.error('[Interaction Error]', err);
    try {
      if (interaction.isRepliable && interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: `${EMOJI_CROSS} Something went wrong. Please try again.`, flags: MessageFlags.Ephemeral });
      }
    } catch (_) {}
  }
});

client.on(Events.Error, (err) => {
  console.error('[Discord Client Error]', err.message);
});

// Diagnostic: warn when something blocks the event loop long enough to expire button clicks
let lastBeat = Date.now();
setInterval(() => {
  const now = Date.now();
  const lag = now - lastBeat - 1000;
  if (lag > 1500) console.warn(`[Lag] Event loop was blocked for ~${lag}ms (buttons may time out).`);
  lastBeat = now;
}, 1000).unref();

// Process Safeguards
process.on('unhandledRejection', (reason) => {
  console.error('[Process Safeguard] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Process Safeguard] Uncaught Exception:', err.message);
});

// Keep-alive web server for 24/7 hosts (Render, Railway, Replit, UptimeRobot pings)
const http = require('http');
const KEEPALIVE_PORT = process.env.PORT || process.env.SERVER_PORT;
if (KEEPALIVE_PORT) {
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`CypherX AFK is running. Active bots: ${manager.getActiveCount()}`);
  }).listen(KEEPALIVE_PORT, () => console.log(`[CypherX AFK] Keep-alive server on port ${KEEPALIVE_PORT}`));
}

client.login(TOKEN);
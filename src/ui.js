const fs = require('fs');
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
  MessageFlags,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize
} = require('discord.js');
const { E, B } = require('./emojis');

const DEFAULT_PANEL_CONFIG = {
  mode: 'v2',            // 'v2' = Components V2 container, 'embed' = classic embed
  color: null,           // null = no accent bar (same look as the help menu); set with ,setcolor
  thumbnail: null,       // { type: 'url', value } or { type: 'file', path, name }
  image: null
};

const FEATURES = [
  `${E.CHECK} Anti-AFK: Jump / Walk / Sneak`,
  `${E.SWORD} Grind Mode: Kills Mobs, Handles Creepers`,
  `${E.PICKAXE} Chops Wood, Gathers Blocks & Crafts Items`,
  `${E.LOCK} Auto Register & Auto Login`,
  `${E.MESSAGE} Customizable Auto-Message & Timer`,
  `${E.RESTART} 24/7 Auto-Reconnect`
];

const V2_FEATURES = [
  { emoji: E.CHECK, text: 'Anti-AFK: Jump / Walk / Sneak' },
  { emoji: E.SWORD, text: 'Grind Mode: Kills Mobs, Handles Creepers' },
  { emoji: E.PICKAXE, text: 'Chops Wood, Gathers Blocks & Crafts Items' },
  { emoji: E.LOCK, text: 'Auto Register & Auto Login' },
  { emoji: E.MESSAGE, text: 'Customizable Auto-Message & Timer' },
  { emoji: E.RESTART, text: '24/7 Auto-Reconnect' }
];

// Big heading + quoted description + bold call-to-action (like a welcome card)
function buildHeaderMarkdown() {
  const quoted = [
    'Manage your personal AFK Minecraft bot using the buttons below.',
    '',
    ...FEATURES.map(f => `» ${f}`)
  ].map(line => `> ${line}`.trimEnd()).join('\n');

  return (
    '# CypherX AFK Control Panel\n' +
    `${quoted}\n\n` +
    '**Click Register first, then press Start!**'
  );
}

// V2 panel header: same layout as the help menu (title, text, bullets, quoted list)
function buildV2Header(activeBots, availableSlots, systemStatus) {
  const quoted = V2_FEATURES.map(f => `> ${f.emoji} » ${f.text}`).join('\n');

  return (
    "# CypherX AFK Control Panel\n" +
    'Manage your personal AFK Minecraft bot using the buttons below.\n\n' +
    `- **System Status:** \`${systemStatus}\`\n` +
    `- **Active Bots:** \`${activeBots}\`\n` +
    `- **Slots Free:** \`${availableSlots}\`\n\n` +
    `${quoted}\n\n` +
    '**Click Register first, then press Start!**'
  );
}

function hexToInt(hex) {
  const n = parseInt(String(hex || '').replace('#', ''), 16);
  return Number.isNaN(n) ? 0x5865F2 : n;
}

// Resolves an asset ({type:'url'|'file'}) into a URL + optional attachment
function resolveAsset(asset, files) {
  if (!asset) return null;
  if (asset.type === 'file') {
    if (!asset.path || !fs.existsSync(asset.path)) return null;
    files.push(new AttachmentBuilder(asset.path, { name: asset.name }));
    return `attachment://${asset.name}`;
  }
  return asset.value || null;
}

function createButtonRows() {
  const primaryRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_register').setLabel('Register').setStyle(ButtonStyle.Primary).setEmoji(B.CHECK),
    new ButtonBuilder().setCustomId('btn_start').setLabel('Start').setStyle(ButtonStyle.Success).setEmoji(B.START),
    new ButtonBuilder().setCustomId('btn_stop').setLabel('Stop').setStyle(ButtonStyle.Danger).setEmoji(B.STOP),
    new ButtonBuilder().setCustomId('btn_restart').setLabel('Restart').setStyle(ButtonStyle.Secondary).setEmoji(B.RESTART)
  );

  const secondaryRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_msg_config').setLabel('Set Message').setStyle(ButtonStyle.Primary).setEmoji(B.INFO),
    new ButtonBuilder().setCustomId('btn_msg_toggle').setLabel('Toggle Message').setStyle(ButtonStyle.Secondary).setEmoji(B.RED_BELL),
    new ButtonBuilder().setCustomId('btn_status').setLabel('Status').setStyle(ButtonStyle.Secondary).setEmoji(B.STATUS_UP),
    new ButtonBuilder().setCustomId('btn_delete').setLabel('Delete Bot').setStyle(ButtonStyle.Danger).setEmoji(B.DELETE)
  );

  const thirdRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_combat').setLabel('Grind Mode').setStyle(ButtonStyle.Secondary).setEmoji(B.SWORD),
    new ButtonBuilder().setCustomId('btn_chop').setLabel('Auto Chop').setStyle(ButtonStyle.Secondary).setEmoji(B.PICKAXE)
  );

  return [primaryRow, secondaryRow, thirdRow];
}

/** Components V2 container panel - same style as the help menu. */
function buildV2Panel(activeBots, availableSlots, systemStatus, config) {
  const files = [];
  const thumbUrl = resolveAsset(config.thumbnail, files) || config.fallbackThumbnail || null;
  const imageUrl = resolveAsset(config.image, files);

  const headerText = new TextDisplayBuilder().setContent(buildV2Header(activeBots, availableSlots, systemStatus));

  const container = new ContainerBuilder();
  if (config.color) container.setAccentColor(hexToInt(config.color));

  if (thumbUrl) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(headerText)
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbUrl))
    );
  } else {
    container.addTextDisplayComponents(headerText);
  }

  if (imageUrl) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(imageUrl))
    );
  }

  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addActionRowComponents(...createButtonRows());
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent('Powered By CypherX AFK'));

  return { components: [container], flags: MessageFlags.IsComponentsV2, files };
}

/** Classic embed panel (fallback style). */
function buildEmbedPanel(activeBots, availableSlots, systemStatus, config) {
  const files = [];
  const thumbUrl = resolveAsset(config.thumbnail, files);
  const imageUrl = resolveAsset(config.image, files);

  const embed = new EmbedBuilder()
    .setDescription(buildHeaderMarkdown())
    .addFields(
      { name: `${E.STATUS_UP} System Status`, value: `\`${systemStatus}\``, inline: true },
      { name: `${E.STOCK} Active Bots`, value: `\`${activeBots}\``, inline: true },
      { name: `${E.BOT} Slots Free`, value: `\`${availableSlots}\``, inline: true }
    )
    .setColor(hexToInt(config.color))
    .setFooter({ text: 'CypherX AFK Panel • Dynamic Sync' })
    .setTimestamp();

  if (thumbUrl) embed.setThumbnail(thumbUrl);
  if (imageUrl) embed.setImage(imageUrl);

  return { embeds: [embed], components: createButtonRows(), files };
}

/** Log message - same look as the panel (V2 container or classic embed, same thumbnail/color/footer). */
function buildLogText(data) {
  const details = String(data.description || 'No additional details.').slice(0, 1500);
  const quoted = details.split('\n').map(line => `> ${line}`.trimEnd()).join('\n');

  return (
    `# ${data.action}\n` +
    'Live activity update from your CypherX AFK bot.\n\n' +
    `- **User:** ${data.user}\n` +
    `- **Bot Name:** \`${data.botName || 'N/A'}\`\n` +
    `- **Server:** \`${data.server || 'N/A'}\`\n\n` +
    quoted
  );
}

function createLogMessage(data, config = {}) {
  // Backwards compatible: a plain string is treated as the fallback thumbnail URL
  const cfg = {
    ...DEFAULT_PANEL_CONFIG,
    ...(typeof config === 'string' ? { fallbackThumbnail: config } : config)
  };

  const files = [];
  const thumbUrl = resolveAsset(cfg.thumbnail, files) || cfg.fallbackThumbnail || null;

  if (cfg.mode === 'embed') {
    const embed = new EmbedBuilder()
      .setDescription(buildLogText(data))
      .setColor(hexToInt(cfg.color))
      .setFooter({ text: 'CypherX AFK Panel • Dynamic Sync' })
      .setTimestamp();
    if (thumbUrl) embed.setThumbnail(thumbUrl);
    return { embeds: [embed], files, allowedMentions: { parse: [] } };
  }

  const textDisplay = new TextDisplayBuilder().setContent(buildLogText(data));

  const container = new ContainerBuilder();
  if (cfg.color) container.setAccentColor(hexToInt(cfg.color)); // same as the panel: no bar unless ,setcolor is set

  if (thumbUrl) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(textDisplay)
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbUrl))
    );
  } else {
    container.addTextDisplayComponents(textDisplay);
  }

  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent('Powered By CypherX AFK'));

  return { components: [container], flags: MessageFlags.IsComponentsV2, files, allowedMentions: { parse: [] } };
}

function createControlPanel(activeBots = 0, availableSlots = 70, systemStatus = 'Online', config = {}) {
  const cfg = { ...DEFAULT_PANEL_CONFIG, ...config };
  return cfg.mode === 'embed'
    ? buildEmbedPanel(activeBots, availableSlots, systemStatus, cfg)
    : buildV2Panel(activeBots, availableSlots, systemStatus, cfg);
}

function createRegisterModal() {
  const modal = new ModalBuilder()
    .setCustomId('modal_register')
    .setTitle('Register AFK Minecraft Bot');

  const usernameInput = new TextInputBuilder()
    .setCustomId('reg_username')
    .setLabel('Minecraft Bot Username')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('CypherXAfk')
    .setMinLength(3)
    .setMaxLength(16)
    .setRequired(true);

  const serverInput = new TextInputBuilder()
    .setCustomId('reg_server')
    .setLabel('Server Address (IP:Port)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('CypherXAfk.aternos.me:25565')
    .setRequired(true);

  const authPluginInput = new TextInputBuilder()
    .setCustomId('reg_use_auth')
    .setLabel('Has Login/Register Plugin? (yes/no)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('yes or no')
    .setValue('yes')
    .setRequired(true);

  const passwordInput = new TextInputBuilder()
    .setCustomId('reg_password')
    .setLabel('Auth Password')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Leave empty to auto-generate one')
    .setRequired(false);

  const versionInput = new TextInputBuilder()
    .setCustomId('reg_version')
    .setLabel('Minecraft Version')
    .setStyle(TextInputStyle.Short)
    .setValue('26.1.2')
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(usernameInput),
    new ActionRowBuilder().addComponents(serverInput),
    new ActionRowBuilder().addComponents(authPluginInput),
    new ActionRowBuilder().addComponents(passwordInput),
    new ActionRowBuilder().addComponents(versionInput)
  );

  return modal;
}

function createAutoMessageModal(currentMsg = 'Subscribe To SpookyMob', currentInterval = '1') {
  const modal = new ModalBuilder()
    .setCustomId('modal_automessage')
    .setTitle('Configure Auto-Message');

  const messageInput = new TextInputBuilder()
    .setCustomId('msg_text')
    .setLabel('Message to Broadcast in Chat')
    .setStyle(TextInputStyle.Short)
    .setValue(currentMsg)
    .setRequired(true);

  const intervalInput = new TextInputBuilder()
    .setCustomId('msg_interval')
    .setLabel('Interval Timer (in Minutes)')
    .setStyle(TextInputStyle.Short)
    .setValue(String(currentInterval))
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(messageInput),
    new ActionRowBuilder().addComponents(intervalInput)
  );

  return modal;
}

module.exports = {
  createControlPanel,
  createLogMessage,
  createRegisterModal,
  createAutoMessageModal,
  DEFAULT_PANEL_CONFIG
};
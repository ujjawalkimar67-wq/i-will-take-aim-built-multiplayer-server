const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8765;
const HEARTBEAT_INTERVAL_MS = Number(process.env.LAN_HEARTBEAT_INTERVAL_MS || 10000);
const HEARTBEAT_TIMEOUT_MS = Number(process.env.LAN_HEARTBEAT_TIMEOUT_MS || 60000);
const RESUME_GRACE_MS = Number(process.env.LAN_RESUME_GRACE_MS || 60000);
const DEBUG_LOGS_ENABLED = process.env.LAN_DEBUG_LOGS === "1";
const AIM_TRAINING_MESSAGE_TYPES = new Set([
  "aim_training_state",
  "aim_training_timer",
  "aim_training_target_state",
  "aim_training_target_respawn",
  "aim_training_finished",
  "aim_training_exit",
  "aim_training_restart"
]);

function normalizeSessionMapId(mapId) {
  const normalizedMapId = String(mapId || "").trim();
  return normalizedMapId || "defaultVillage";
}

function normalizeResumeToken(token) {
  return String(token || "").trim();
}

function makePlayerId(prefix) {
  return `${prefix}-${crypto.randomBytes(3).toString("hex")}`;
}

function nowMs() {
  return Date.now();
}

function logLanDebug(eventName, details = {}) {
  if (!DEBUG_LOGS_ENABLED) {
    return;
  }

  console.log("[LAN DEBUG]", {
    at: new Date().toISOString(),
    event: eventName,
    ...details
  });
}

function safeSendJson(connection, payload) {
  if (!connection?.socket || connection.socket.readyState !== connection.socket.OPEN) {
    return false;
  }

  connection.socket.send(JSON.stringify(payload));
  return true;
}

class LanRelaySession {
  constructor() {
    this.hostId = "";
    this.players = new Map();
  }

  getHostRecord() {
    return this.players.get(this.hostId) || null;
  }

  touchPlayer(record) {
    if (!record) {
      return;
    }

    record.lastPacketAt = nowMs();
  }

  resolveSessionMapId() {
    const hostRecord = this.getHostRecord();
    if (!hostRecord) {
      return "defaultVillage";
    }

    return normalizeSessionMapId(
      hostRecord.sessionMapId ||
      hostRecord.state?.mapId
    );
  }

  getPlayerSnapshot(record) {
    return {
      playerId: record.playerId,
      role: record.role,
      name: record.name,
      state: record.state,
      lastPacketAt: record.lastPacketAt,
      connected: Boolean(record.isConnected)
    };
  }

  listOtherPlayers(excludePlayerId) {
    const otherPlayers = [];
    for (const [playerId, record] of this.players) {
      if (playerId === excludePlayerId) {
        continue;
      }

      otherPlayers.push(this.getPlayerSnapshot(record));
    }

    return otherPlayers;
  }

  broadcast(payload, { excludePlayerId = "" } = {}) {
    for (const [playerId, record] of this.players) {
      if (playerId === excludePlayerId || !record.isConnected) {
        continue;
      }

      safeSendJson(record, payload);
    }
  }

  sendToHost(payload) {
    const hostRecord = this.getHostRecord();
    if (!hostRecord?.isConnected) {
      return false;
    }

    return safeSendJson(hostRecord, payload);
  }

  sendError(connection, message, code = "network_error") {
    safeSendJson(connection, {
      type: "error",
      code,
      message
    });
  }

  rejectHandshake(connection, message, code = "network_error", closeReason = "Handshake rejected") {
    this.sendError(connection, message, code);

    try {
      connection.socket.close(1008, closeReason);
    } catch (error) {
      // Ignore close errors during handshake rejection.
    }
  }

  createPlayerRecord(role, message, address) {
    return {
      socket: null,
      address,
      playerId: "",
      role,
      name: String(message.name || "").trim(),
      sessionMapId: normalizeSessionMapId(message.mapId),
      state: null,
      lastPacketAt: nowMs(),
      resumeToken: normalizeResumeToken(message.resumeToken) || makePlayerId("resume"),
      isConnected: false,
      disconnectedAt: 0
    };
  }

  resolveResumeRecord(role, message) {
    const requestedPlayerId = String(message.playerId || "").trim();
    const requestedResumeToken = normalizeResumeToken(message.resumeToken);
    if (!requestedPlayerId || !requestedResumeToken) {
      return null;
    }

    const record = this.players.get(requestedPlayerId);
    if (!record || record.role !== role || record.resumeToken !== requestedResumeToken) {
      return null;
    }

    return record;
  }

  attachConnection(record, connection) {
    if (
      record.socket &&
      record.socket !== connection.socket &&
      record.socket.readyState === record.socket.OPEN
    ) {
      try {
        record.socket.close(1012, "Connection replaced");
      } catch (error) {
        // Ignore cleanup errors during a resumed attach.
      }
    }

    record.socket = connection.socket;
    record.address = connection.address;
    record.isConnected = true;
    record.disconnectedAt = 0;
    this.touchPlayer(record);

    connection.playerRecord = record;
  }

  updateHandshakeDetails(record, message) {
    record.name = String(message.name || "").trim();
    record.sessionMapId = normalizeSessionMapId(message.mapId);
    this.touchPlayer(record);
  }

  sendSessionReady(record, { isResume = false } = {}) {
    safeSendJson(record, {
      type: "session_ready",
      playerId: record.playerId,
      role: record.role,
      hostId: this.hostId,
      sessionMapId: this.resolveSessionMapId(),
      players: this.listOtherPlayers(record.playerId),
      resumeToken: record.resumeToken,
      isResume,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
      resumeGraceMs: RESUME_GRACE_MS
    });
  }

  registerHost(connection, message) {
    const wantsResume = Boolean(message.resume);
    const resumeRecord = this.resolveResumeRecord("host", message);

    if (wantsResume && !resumeRecord) {
      logLanDebug("reconnect_attempt_failed", {
        role: "host",
        address: connection.address,
        playerId: String(message.playerId || "").trim(),
        reason: "resume_not_available"
      });
      this.rejectHandshake(
        connection,
        "The hosted multiplayer session could not be restored.",
        "resume_not_available",
        "Resume unavailable"
      );
      return;
    }

    if (resumeRecord) {
      this.updateHandshakeDetails(resumeRecord, message);
      this.attachConnection(resumeRecord, connection);
      this.hostId = resumeRecord.playerId;

      logLanDebug("reconnect_attempt_succeeded", {
        role: "host",
        playerId: resumeRecord.playerId,
        address: resumeRecord.address
      });
      console.log(`[LAN] Host resumed: ${resumeRecord.playerId} (${resumeRecord.address})`);
      this.sendSessionReady(resumeRecord, { isResume: true });
      this.broadcast({
        type: "host_reconnected",
        playerId: resumeRecord.playerId,
        name: resumeRecord.name
      }, {
        excludePlayerId: resumeRecord.playerId
      });
      return;
    }

    const activeHost = this.getHostRecord();
    if (activeHost) {
      this.rejectHandshake(
        connection,
        "A LAN host is already active on this server.",
        "host_exists",
        "Host already active"
      );
      return;
    }

    const record = this.createPlayerRecord("host", message, connection.address);
    record.playerId = makePlayerId("host");
    this.attachConnection(record, connection);

    this.hostId = record.playerId;
    this.players.set(record.playerId, record);

    console.log(`[LAN] Host registered: ${record.playerId} (${record.address})`);
    this.sendSessionReady(record, { isResume: false });
  }

  registerClient(connection, message) {
    const wantsResume = Boolean(message.resume);
    const resumeRecord = this.resolveResumeRecord("client", message);

    if (wantsResume && !resumeRecord) {
      logLanDebug("reconnect_attempt_failed", {
        role: "client",
        address: connection.address,
        playerId: String(message.playerId || "").trim(),
        reason: "resume_not_available"
      });
      this.rejectHandshake(
        connection,
        "This multiplayer session could not be restored.",
        "resume_not_available",
        "Resume unavailable"
      );
      return;
    }

    const hostRecord = this.getHostRecord();
    if (!hostRecord) {
      this.rejectHandshake(
        connection,
        "No active LAN host is running on this server.",
        "no_host",
        "No active host"
      );
      return;
    }

    if (resumeRecord) {
      this.updateHandshakeDetails(resumeRecord, message);
      this.attachConnection(resumeRecord, connection);

      logLanDebug("reconnect_attempt_succeeded", {
        role: "client",
        playerId: resumeRecord.playerId,
        address: resumeRecord.address
      });
      console.log(`[LAN] Client resumed: ${resumeRecord.playerId} (${resumeRecord.address})`);
      this.sendSessionReady(resumeRecord, { isResume: true });
      this.broadcast({
        type: "peer_reconnected",
        playerId: resumeRecord.playerId,
        role: resumeRecord.role,
        name: resumeRecord.name,
        state: resumeRecord.state,
        lastPacketAt: resumeRecord.lastPacketAt
      }, {
        excludePlayerId: resumeRecord.playerId
      });
      return;
    }

    if (!hostRecord.isConnected) {
      this.rejectHandshake(
        connection,
        "The host is reconnecting. Please wait a moment and try again.",
        "host_reconnecting",
        "Host reconnecting"
      );
      return;
    }

    const record = this.createPlayerRecord("client", message, connection.address);
    record.playerId = makePlayerId("client");
    this.attachConnection(record, connection);
    this.players.set(record.playerId, record);

    console.log(`[LAN] Client joined: ${record.playerId} (${record.address})`);
    this.sendSessionReady(record, { isResume: false });
    this.broadcast({
      type: "peer_joined",
      playerId: record.playerId,
      role: record.role,
      name: record.name,
      state: record.state,
      lastPacketAt: record.lastPacketAt
    }, {
      excludePlayerId: record.playerId
    });
  }

  forwardPlayerState(connection, state) {
    const record = connection.playerRecord;
    if (!record?.playerId || !state || typeof state !== "object" || Array.isArray(state)) {
      this.sendError(connection, "player_state requires an active session and a state object.", "invalid_state");
      return;
    }

    record.state = state;
    record.sessionMapId = normalizeSessionMapId(state.mapId);
    this.touchPlayer(record);

    this.broadcast({
      type: "player_state",
      playerId: record.playerId,
      state: record.state,
      timestamp: record.lastPacketAt
    }, {
      excludePlayerId: record.playerId
    });
  }

  relayPlayerShot(connection, shot) {
    const record = connection.playerRecord;
    if (!record?.playerId || !shot || typeof shot !== "object" || Array.isArray(shot)) {
      this.sendError(connection, "player_shot requires an active session and a shot object.", "invalid_shot");
      return;
    }

    this.touchPlayer(record);
    this.broadcast({
      type: "player_shot",
      playerId: record.playerId,
      shot,
      timestamp: record.lastPacketAt
    }, {
      excludePlayerId: record.playerId
    });
  }

  requireHostAuthority(connection, messageType) {
    const record = connection.playerRecord;
    if (!record || record.playerId !== this.hostId) {
      this.sendError(connection, `${messageType} is host-authoritative and can only be sent by the host.`, "host_only");
      return false;
    }

    return true;
  }

  forwardEnemySpawnRequest(connection, message) {
    const record = connection.playerRecord;
    if (!record?.playerId) {
      this.sendError(connection, "enemy_spawn_request requires an active session.", "invalid_session");
      return;
    }

    const hostRecord = this.getHostRecord();
    if (!hostRecord) {
      this.sendError(connection, "No active LAN host is available for enemy spawns.", "no_host");
      return;
    }

    if (!hostRecord.isConnected) {
      this.sendError(connection, "The host is reconnecting. Please wait a moment.", "host_reconnecting");
      return;
    }

    this.touchPlayer(record);
    this.sendToHost({
      type: "enemy_spawn_request",
      playerId: record.playerId,
      count: Math.max(1, Number(message.count) || 1),
      difficultyKey: String(message.difficultyKey || "")
    });
  }

  forwardEnemyWaveRequest(connection, message) {
    const record = connection.playerRecord;
    if (!record?.playerId) {
      this.sendError(connection, "enemy_wave_request requires an active session.", "invalid_session");
      return;
    }

    const hostRecord = this.getHostRecord();
    if (!hostRecord) {
      this.sendError(connection, "No active LAN host is available for wave requests.", "no_host");
      return;
    }

    if (!hostRecord.isConnected) {
      this.sendError(connection, "The host is reconnecting. Please wait a moment.", "host_reconnecting");
      return;
    }

    this.touchPlayer(record);
    this.sendToHost({
      type: "enemy_wave_request",
      playerId: record.playerId,
      enemyCount: Math.max(1, Number(message.enemyCount) || 1),
      waveCount: Math.max(1, Number(message.waveCount) || 1),
      difficultyKey: String(message.difficultyKey || "")
    });
  }

  broadcastCombatState(connection, players) {
    const record = connection.playerRecord;
    if (!this.requireHostAuthority(connection, "player_combat_state")) {
      return;
    }

    const payloadPlayers = Array.isArray(players) ? players : [];
    this.touchPlayer(record);
    this.broadcast({
      type: "player_combat_state",
      players: payloadPlayers
    }, {
      excludePlayerId: record.playerId
    });
  }

  broadcastPlayerDamage(connection, message) {
    const record = connection.playerRecord;
    if (!this.requireHostAuthority(connection, "player_damage")) {
      return;
    }

    this.touchPlayer(record);
    this.broadcast({
      type: "player_damage",
      playerId: String(message.playerId || ""),
      attackerId: String(message.attackerId || ""),
      amount: Number(message.amount) || 0,
      hitZone: String(message.hitZone || "body"),
      hp: Number(message.hp) || 0,
      maxHp: Number(message.maxHp) || 100,
      isDead: Boolean(message.isDead)
    }, {
      excludePlayerId: record.playerId
    });
  }

  broadcastPlayerRespawn(connection, message) {
    const record = connection.playerRecord;
    if (!this.requireHostAuthority(connection, "player_respawn")) {
      return;
    }

    if (!message?.state || typeof message.state !== "object" || Array.isArray(message.state)) {
      this.sendError(connection, "player_respawn requires a state object.", "invalid_respawn_state");
      return;
    }

    this.touchPlayer(record);
    this.broadcast({
      type: "player_respawn",
      playerId: String(message.playerId || ""),
      hp: Number(message.hp) || 100,
      maxHp: Number(message.maxHp) || 100,
      state: message.state
    }, {
      excludePlayerId: record.playerId
    });
  }

  broadcastEnemySpawn(connection, enemies) {
    const record = connection.playerRecord;
    if (!this.requireHostAuthority(connection, "enemy_spawned")) {
      return;
    }

    this.touchPlayer(record);
    this.broadcast({
      type: "enemy_spawned",
      enemies: Array.isArray(enemies) ? enemies : []
    }, {
      excludePlayerId: record.playerId
    });
  }

  broadcastEnemyState(connection, enemies) {
    const record = connection.playerRecord;
    if (!this.requireHostAuthority(connection, "enemy_state")) {
      return;
    }

    this.touchPlayer(record);
    this.broadcast({
      type: "enemy_state",
      enemies: Array.isArray(enemies) ? enemies : []
    }, {
      excludePlayerId: record.playerId
    });
  }

  broadcastEnemyDamage(connection, message) {
    const record = connection.playerRecord;
    if (!this.requireHostAuthority(connection, "enemy_damage")) {
      return;
    }

    this.touchPlayer(record);
    this.broadcast({
      type: "enemy_damage",
      enemyId: String(message.enemyId || ""),
      attackerId: String(message.attackerId || ""),
      amount: Number(message.amount) || 0,
      hitZone: String(message.hitZone || "body"),
      hp: Number(message.hp) || 0,
      maxHp: Number(message.maxHp) || 100,
      isDead: Boolean(message.isDead)
    }, {
      excludePlayerId: record.playerId
    });
  }

  broadcastEnemyRemoved(connection, message) {
    const record = connection.playerRecord;
    if (!this.requireHostAuthority(connection, "enemy_removed")) {
      return;
    }

    this.touchPlayer(record);
    this.broadcast({
      type: "enemy_removed",
      enemyId: String(message.enemyId || ""),
      reason: String(message.reason || "removed")
    }, {
      excludePlayerId: record.playerId
    });
  }

  broadcastEnemyAttack(connection, message) {
    const record = connection.playerRecord;
    if (!this.requireHostAuthority(connection, "enemy_attack")) {
      return;
    }

    this.touchPlayer(record);
    this.broadcast({
      type: "enemy_attack",
      enemyId: String(message.enemyId || ""),
      targetPlayerId: String(message.targetPlayerId || "")
    }, {
      excludePlayerId: record.playerId
    });
  }

  broadcastHealthPickupSpawn(connection, message) {
    const record = connection.playerRecord;
    if (!this.requireHostAuthority(connection, "health_pickup_spawned")) {
      return;
    }

    this.touchPlayer(record);
    this.broadcast({
      type: "health_pickup_spawned",
      pickups: Array.isArray(message.pickups) ? message.pickups : []
    }, {
      excludePlayerId: record.playerId
    });
  }

  broadcastHealthPickupRemoved(connection, message) {
    const record = connection.playerRecord;
    if (!this.requireHostAuthority(connection, "health_pickup_removed")) {
      return;
    }

    this.touchPlayer(record);
    this.broadcast({
      type: "health_pickup_removed",
      pickupId: String(message.pickupId || ""),
      reason: String(message.reason || "removed"),
      removedBy: String(message.removedBy || "")
    }, {
      excludePlayerId: record.playerId
    });
  }

  broadcastAimTrainingMessage(connection, message) {
    const record = connection.playerRecord;
    if (!this.requireHostAuthority(connection, message.type || "aim_training_sync")) {
      return;
    }

    this.touchPlayer(record);

    const payload = {
      type: String(message.type || ""),
      playerId: record.playerId
    };

    if (message.state && typeof message.state === "object" && !Array.isArray(message.state)) {
      payload.state = message.state;
    }
    if (typeof message.mode === "string") {
      payload.mode = message.mode;
    }
    if (Number.isFinite(Number(message.remainingSeconds))) {
      payload.remainingSeconds = Math.max(0, Math.ceil(Number(message.remainingSeconds)));
    }
    if (message.targetState && typeof message.targetState === "object" && !Array.isArray(message.targetState)) {
      payload.targetState = message.targetState;
    }

    this.broadcast(payload, {
      excludePlayerId: record.playerId
    });
  }

  handleExplicitLeave(connection) {
    const record = connection.playerRecord;
    if (!record || !this.players.has(record.playerId)) {
      return;
    }

    connection.handledDisconnect = true;
    if (record.socket === connection.socket) {
      record.socket = null;
      record.isConnected = false;
      record.disconnectedAt = nowMs();
    }

    this.finalizeDisconnect(record, { reason: "left" });

    try {
      connection.socket.close(1000, "Leaving session");
    } catch (error) {
      // Ignore close errors during leave cleanup.
    }
  }

  handleMessage(connection, message) {
    const messageType = message?.type;

    if (messageType === "host_session") {
      this.registerHost(connection, message);
      return;
    }

    if (messageType === "join_session") {
      this.registerClient(connection, message);
      return;
    }

    if (messageType === "leave_session") {
      this.handleExplicitLeave(connection);
      return;
    }

    if (messageType === "client_heartbeat") {
      this.touchPlayer(connection.playerRecord);
      return;
    }

    if (messageType === "player_state") {
      this.forwardPlayerState(connection, message.state);
      return;
    }

    if (messageType === "player_shot") {
      this.relayPlayerShot(connection, message.shot);
      return;
    }

    if (messageType === "enemy_spawn_request") {
      this.forwardEnemySpawnRequest(connection, message);
      return;
    }

    if (messageType === "enemy_wave_request") {
      this.forwardEnemyWaveRequest(connection, message);
      return;
    }

    if (messageType === "player_combat_state") {
      this.broadcastCombatState(connection, message.players);
      return;
    }

    if (messageType === "player_damage") {
      this.broadcastPlayerDamage(connection, message);
      return;
    }

    if (messageType === "player_respawn") {
      this.broadcastPlayerRespawn(connection, message);
      return;
    }

    if (messageType === "enemy_spawned") {
      this.broadcastEnemySpawn(connection, message.enemies);
      return;
    }

    if (messageType === "enemy_state") {
      this.broadcastEnemyState(connection, message.enemies);
      return;
    }

    if (messageType === "enemy_damage") {
      this.broadcastEnemyDamage(connection, message);
      return;
    }

    if (messageType === "enemy_removed") {
      this.broadcastEnemyRemoved(connection, message);
      return;
    }

    if (messageType === "enemy_attack") {
      this.broadcastEnemyAttack(connection, message);
      return;
    }

    if (messageType === "health_pickup_spawned") {
      this.broadcastHealthPickupSpawn(connection, message);
      return;
    }

    if (messageType === "health_pickup_removed") {
      this.broadcastHealthPickupRemoved(connection, message);
      return;
    }

    if (AIM_TRAINING_MESSAGE_TYPES.has(messageType)) {
      this.broadcastAimTrainingMessage(connection, message);
      return;
    }

    this.sendError(connection, `Unsupported message type: ${JSON.stringify(messageType)}`, "unsupported_message");
  }

  handleSocketClose(connection) {
    if (connection.handledDisconnect) {
      return;
    }

    const record = connection.playerRecord;
    if (!record || !this.players.has(record.playerId) || record.socket !== connection.socket) {
      return;
    }

    record.socket = null;
    record.isConnected = false;
    record.disconnectedAt = nowMs();
    record.lastPacketAt = nowMs();

    if (record.playerId === this.hostId) {
      console.log(`[LAN] Host connection lost: ${record.playerId}`);
      this.broadcast({
        type: "host_connection_lost",
        playerId: record.playerId,
        graceMs: RESUME_GRACE_MS
      }, {
        excludePlayerId: record.playerId
      });
      return;
    }

    console.log(`[LAN] Client connection lost: ${record.playerId}`);
    this.broadcast({
      type: "peer_connection_lost",
      playerId: record.playerId,
      graceMs: RESUME_GRACE_MS
    }, {
      excludePlayerId: record.playerId
    });
  }

  finalizeDisconnect(record, { reason = "left" } = {}) {
    if (!record?.playerId || !this.players.has(record.playerId)) {
      return;
    }

    this.players.delete(record.playerId);

    if (record.playerId === this.hostId) {
      const remainingPlayers = [...this.players.values()];
      this.players.clear();
      this.hostId = "";

      const sessionReason = reason === "left" ? "host_left" : "host_disconnected";
      console.log(`[LAN] Host session ended: ${record.playerId} (${sessionReason})`);

      for (const remainingPlayer of remainingPlayers) {
        safeSendJson(remainingPlayer, {
          type: "session_closed",
          reason: sessionReason
        });

        try {
          remainingPlayer.socket?.close(
            1001,
            sessionReason === "host_left" ? "Host left" : "Host disconnected"
          );
        } catch (error) {
          // Ignore close errors during cleanup.
        }
      }
      return;
    }

    const leaveReason = reason === "left" ? "left" : "reconnect_failed";
    console.log(`[LAN] Client removed: ${record.playerId} (${leaveReason})`);
    this.broadcast({
      type: "peer_left",
      playerId: record.playerId,
      reason: leaveReason
    }, {
      excludePlayerId: record.playerId
    });
  }

  performMaintenance() {
    const currentTime = nowMs();

    for (const record of [...this.players.values()]) {
      if (record.isConnected) {
        const elapsedSincePacketMs = currentTime - record.lastPacketAt;
        if (elapsedSincePacketMs > HEARTBEAT_TIMEOUT_MS) {
          logLanDebug("heartbeat_missed", {
            playerId: record.playerId,
            role: record.role,
            address: record.address,
            elapsedMs: elapsedSincePacketMs,
            timeoutMs: HEARTBEAT_TIMEOUT_MS
          });
          console.warn(`[LAN] Heartbeat timeout for ${record.playerId}`);
          const activeSocket = record.socket;
          if (activeSocket && activeSocket.readyState !== activeSocket.CLOSED) {
            activeSocket.__heartbeatTimeout = true;
            try {
              activeSocket.terminate?.();
            } catch (error) {
              try {
                activeSocket.close(4000, "Heartbeat timeout");
              } catch (closeError) {
                // Ignore close errors during timeout cleanup.
              }
            }
          }
          continue;
        }

        safeSendJson(record, {
          type: "server_heartbeat",
          timestamp: currentTime
        });
        continue;
      }

      if (record.disconnectedAt && currentTime - record.disconnectedAt >= RESUME_GRACE_MS) {
        logLanDebug("grace_window_expired", {
          playerId: record.playerId,
          role: record.role,
          address: record.address,
          disconnectedForMs: currentTime - record.disconnectedAt,
          graceMs: RESUME_GRACE_MS,
          reason: record.playerId === this.hostId ? "host_reconnect_expired" : "player_reconnect_expired"
        });
        this.finalizeDisconnect(record, { reason: "timeout" });
      }
    }
  }
}

const session = new LanRelaySession();

const host = process.env.LAN_SERVER_HOST || DEFAULT_HOST;
const port = Number(process.env.LAN_SERVER_PORT || DEFAULT_PORT);

const wss = new WebSocketServer({
  host,
  port
});

const maintenanceIntervalId = setInterval(() => {
  session.performMaintenance();
}, HEARTBEAT_INTERVAL_MS);
maintenanceIntervalId.unref?.();

wss.on("connection", (socket, request) => {
  const connection = {
    socket,
    address: request.socket.remoteAddress || "unknown",
    playerRecord: null,
    handledDisconnect: false
  };

  socket.on("message", (rawMessage, isBinary) => {
    if (isBinary) {
      session.sendError(connection, "Only UTF-8 text messages are supported.", "binary_not_supported");
      return;
    }

    let message;
    try {
      message = JSON.parse(rawMessage.toString("utf-8"));
    } catch (error) {
      session.sendError(connection, "Invalid JSON payload.", "invalid_json");
      return;
    }

    if (!message || typeof message !== "object" || Array.isArray(message)) {
      session.sendError(connection, "Top-level JSON payload must be an object.", "invalid_payload");
      return;
    }

    session.handleMessage(connection, message);
  });

  socket.on("close", () => {
    session.handleSocketClose(connection);
  });

  socket.on("error", (error) => {
    console.warn(`[LAN] Socket error from ${connection.address}: ${error.message}`);
  });
});

wss.on("listening", () => {
  console.log(`[LAN] WebSocket relay listening on ws://${host}:${port}`);
  console.log("[LAN] Run 'npm run start:lan' on the host laptop, then host/join from the browser UI.");
});

wss.on("error", (error) => {
  console.error(`[LAN] Relay server error: ${error.message}`);
  process.exitCode = 1;
});

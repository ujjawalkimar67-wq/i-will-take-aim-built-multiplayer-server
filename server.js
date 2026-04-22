const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8765;

function makePlayerId(prefix) {
  return `${prefix}-${crypto.randomBytes(3).toString("hex")}`;
}

function nowMs() {
  return Date.now();
}

function safeSendJson(connection, payload) {
  if (!connection || connection.socket.readyState !== connection.socket.OPEN) {
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

  getPlayerSnapshot(connection) {
    return {
      playerId: connection.playerId,
      role: connection.role,
      name: connection.name,
      state: connection.state,
      lastPacketAt: connection.lastPacketAt
    };
  }

  listOtherPlayers(excludePlayerId) {
    const otherPlayers = [];
    for (const [playerId, connection] of this.players) {
      if (playerId === excludePlayerId) {
        continue;
      }

      otherPlayers.push(this.getPlayerSnapshot(connection));
    }

    return otherPlayers;
  }

  broadcast(payload, { excludePlayerId = "" } = {}) {
    for (const [playerId, connection] of this.players) {
      if (playerId === excludePlayerId) {
        continue;
      }

      safeSendJson(connection, payload);
    }
  }

  sendToHost(payload) {
    const hostConnection = this.players.get(this.hostId);
    if (!hostConnection) {
      return false;
    }

    return safeSendJson(hostConnection, payload);
  }

  sendError(connection, message) {
    safeSendJson(connection, {
      type: "error",
      message
    });
  }

  registerHost(connection, message) {
    if (this.hostId && this.hostId !== connection.playerId) {
      this.sendError(connection, "A LAN host is already active on this server.");
      return;
    }

    if (!connection.playerId) {
      connection.playerId = makePlayerId("host");
    }

    connection.role = "host";
    connection.name = String(message.name || "").trim();
    connection.lastPacketAt = nowMs();

    this.hostId = connection.playerId;
    this.players.set(connection.playerId, connection);

    console.log(`[LAN] Host registered: ${connection.playerId} (${connection.address})`);
    safeSendJson(connection, {
      type: "session_ready",
      playerId: connection.playerId,
      role: "host",
      hostId: this.hostId,
      players: this.listOtherPlayers(connection.playerId)
    });
  }

  registerClient(connection, message) {
    if (!this.hostId || !this.players.has(this.hostId)) {
      this.sendError(connection, "No active LAN host is running on this server.");
      return;
    }

    if (!connection.playerId) {
      connection.playerId = makePlayerId("client");
    }

    connection.role = "client";
    connection.name = String(message.name || "").trim();
    connection.lastPacketAt = nowMs();
    this.players.set(connection.playerId, connection);

    console.log(`[LAN] Client joined: ${connection.playerId} (${connection.address})`);
    safeSendJson(connection, {
      type: "session_ready",
      playerId: connection.playerId,
      role: "client",
      hostId: this.hostId,
      players: this.listOtherPlayers(connection.playerId)
    });
    this.broadcast({
      type: "peer_joined",
      playerId: connection.playerId,
      role: connection.role,
      name: connection.name,
      state: connection.state,
      lastPacketAt: connection.lastPacketAt
    }, {
      excludePlayerId: connection.playerId
    });
  }

  forwardPlayerState(connection, state) {
    if (!connection.playerId || !state || typeof state !== "object" || Array.isArray(state)) {
      this.sendError(connection, "player_state requires an active session and a state object.");
      return;
    }

    connection.state = state;
    connection.lastPacketAt = nowMs();

    this.broadcast({
      type: "player_state",
      playerId: connection.playerId,
      state: connection.state,
      timestamp: connection.lastPacketAt
    }, {
      excludePlayerId: connection.playerId
    });
  }

  relayPlayerShot(connection, shot) {
    if (!connection.playerId || !shot || typeof shot !== "object" || Array.isArray(shot)) {
      this.sendError(connection, "player_shot requires an active session and a shot object.");
      return;
    }

    connection.lastPacketAt = nowMs();
    this.broadcast({
      type: "player_shot",
      playerId: connection.playerId,
      shot,
      timestamp: connection.lastPacketAt
    }, {
      excludePlayerId: connection.playerId
    });
  }

  requireHostAuthority(connection, messageType) {
    if (connection.playerId !== this.hostId) {
      this.sendError(connection, `${messageType} is host-authoritative and can only be sent by the host.`);
      return false;
    }

    return true;
  }

  forwardEnemySpawnRequest(connection, message) {
    if (!connection.playerId) {
      this.sendError(connection, "enemy_spawn_request requires an active session.");
      return;
    }

    if (!this.hostId || !this.players.has(this.hostId)) {
      this.sendError(connection, "No active LAN host is available for enemy spawns.");
      return;
    }

    connection.lastPacketAt = nowMs();
    this.sendToHost({
      type: "enemy_spawn_request",
      playerId: connection.playerId,
      count: Math.max(1, Number(message.count) || 1),
      difficultyKey: String(message.difficultyKey || "")
    });
  }

  forwardEnemyWaveRequest(connection, message) {
    if (!connection.playerId) {
      this.sendError(connection, "enemy_wave_request requires an active session.");
      return;
    }

    if (!this.hostId || !this.players.has(this.hostId)) {
      this.sendError(connection, "No active LAN host is available for wave requests.");
      return;
    }

    connection.lastPacketAt = nowMs();
    this.sendToHost({
      type: "enemy_wave_request",
      playerId: connection.playerId,
      enemyCount: Math.max(1, Number(message.enemyCount) || 1),
      waveCount: Math.max(1, Number(message.waveCount) || 1),
      difficultyKey: String(message.difficultyKey || "")
    });
  }

  broadcastCombatState(connection, players) {
    if (!this.requireHostAuthority(connection, "player_combat_state")) {
      return;
    }

    const payloadPlayers = Array.isArray(players) ? players : [];
    connection.lastPacketAt = nowMs();
    this.broadcast({
      type: "player_combat_state",
      players: payloadPlayers
    }, {
      excludePlayerId: connection.playerId
    });
  }

  broadcastPlayerDamage(connection, message) {
    if (!this.requireHostAuthority(connection, "player_damage")) {
      return;
    }

    connection.lastPacketAt = nowMs();
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
      excludePlayerId: connection.playerId
    });
  }

  broadcastPlayerRespawn(connection, message) {
    if (!this.requireHostAuthority(connection, "player_respawn")) {
      return;
    }

    if (!message?.state || typeof message.state !== "object" || Array.isArray(message.state)) {
      this.sendError(connection, "player_respawn requires a state object.");
      return;
    }

    connection.lastPacketAt = nowMs();
    this.broadcast({
      type: "player_respawn",
      playerId: String(message.playerId || ""),
      hp: Number(message.hp) || 100,
      maxHp: Number(message.maxHp) || 100,
      state: message.state
    }, {
      excludePlayerId: connection.playerId
    });
  }

  broadcastEnemySpawn(connection, enemies) {
    if (!this.requireHostAuthority(connection, "enemy_spawned")) {
      return;
    }

    connection.lastPacketAt = nowMs();
    this.broadcast({
      type: "enemy_spawned",
      enemies: Array.isArray(enemies) ? enemies : []
    }, {
      excludePlayerId: connection.playerId
    });
  }

  broadcastEnemyState(connection, enemies) {
    if (!this.requireHostAuthority(connection, "enemy_state")) {
      return;
    }

    connection.lastPacketAt = nowMs();
    this.broadcast({
      type: "enemy_state",
      enemies: Array.isArray(enemies) ? enemies : []
    }, {
      excludePlayerId: connection.playerId
    });
  }

  broadcastEnemyDamage(connection, message) {
    if (!this.requireHostAuthority(connection, "enemy_damage")) {
      return;
    }

    connection.lastPacketAt = nowMs();
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
      excludePlayerId: connection.playerId
    });
  }

  broadcastEnemyRemoved(connection, message) {
    if (!this.requireHostAuthority(connection, "enemy_removed")) {
      return;
    }

    connection.lastPacketAt = nowMs();
    this.broadcast({
      type: "enemy_removed",
      enemyId: String(message.enemyId || ""),
      reason: String(message.reason || "removed")
    }, {
      excludePlayerId: connection.playerId
    });
  }

  broadcastEnemyAttack(connection, message) {
    if (!this.requireHostAuthority(connection, "enemy_attack")) {
      return;
    }

    connection.lastPacketAt = nowMs();
    this.broadcast({
      type: "enemy_attack",
      enemyId: String(message.enemyId || ""),
      targetPlayerId: String(message.targetPlayerId || "")
    }, {
      excludePlayerId: connection.playerId
    });
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

    this.sendError(connection, `Unsupported message type: ${JSON.stringify(messageType)}`);
  }

  disconnect(connection) {
    if (!connection.playerId || !this.players.has(connection.playerId)) {
      return;
    }

    this.players.delete(connection.playerId);
    const wasHost = connection.playerId === this.hostId;

    if (wasHost) {
      const remainingPlayers = [...this.players.values()];
      this.players.clear();
      this.hostId = "";
      console.log(`[LAN] Host disconnected: ${connection.playerId}`);

      for (const remainingPlayer of remainingPlayers) {
        safeSendJson(remainingPlayer, {
          type: "session_closed",
          reason: "host_disconnected"
        });
        try {
          remainingPlayer.socket.close(1001, "Host disconnected");
        } catch (error) {
          // Ignore close errors during cleanup.
        }
      }
      return;
    }

    console.log(`[LAN] Client disconnected: ${connection.playerId}`);
    this.broadcast({
      type: "peer_left",
      playerId: connection.playerId
    }, {
      excludePlayerId: connection.playerId
    });
  }
}

const session = new LanRelaySession();

const host = process.env.LAN_SERVER_HOST || DEFAULT_HOST;
const port = Number(process.env.LAN_SERVER_PORT || DEFAULT_PORT);

const wss = new WebSocketServer({
  host,
  port
});

wss.on("connection", (socket, request) => {
  const connection = {
    socket,
    address: request.socket.remoteAddress || "unknown",
    playerId: "",
    role: "",
    name: "",
    state: null,
    lastPacketAt: nowMs()
  };

  socket.on("message", (rawMessage, isBinary) => {
    if (isBinary) {
      session.sendError(connection, "Only UTF-8 text messages are supported.");
      return;
    }

    let message;
    try {
      message = JSON.parse(rawMessage.toString("utf-8"));
    } catch (error) {
      session.sendError(connection, "Invalid JSON payload.");
      return;
    }

    if (!message || typeof message !== "object" || Array.isArray(message)) {
      session.sendError(connection, "Top-level JSON payload must be an object.");
      return;
    }

    session.handleMessage(connection, message);
  });

  socket.on("close", () => {
    session.disconnect(connection);
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

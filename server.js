const express = require("express")
const http = require("http")
const { Server } = require("socket.io")
const { MongoClient } = require("mongodb")
const cors = require("cors")

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI ||
  "mongodb+srv://mihirsonidev:mihir%40123@cluster0.1tah4os.mongodb.net/werewolf?retryWrites=true&w=majority";
const MONGODB_DB = process.env.MONGODB_DB || "werewolf"

let db

// Express app setup
const app = express()
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true,
  }),
)
const server = http.createServer(app)

// Socket.io setup with improved CORS and connection handling
const io = new Server(server, {
  cors: {
    origin: "*", // Allow any origin
    methods: ["GET", "POST"],
    credentials: true,
  },
  allowEIO3: true,
  pingTimeout: 60000,
})

// Track active connections and game subscriptions
const activeConnections = new Map() // socketId -> { gameId, playerId }
const gameSubscriptions = new Map() // gameId -> Set of socketIds

// Game state management
const activeGames = new Map()
const gameTimers = new Map() // gameId -> intervalId

// Connect to MongoDB
async function connectToMongoDB() {
  try {
    const client = new MongoClient(MONGODB_URI)
    await client.connect()
    db = client.db(MONGODB_DB)
    console.log("Connected to MongoDB")
  } catch (error) {
    console.error("MongoDB connection error:", error)
    process.exit(1)
  }
}

// Game logic functions
async function loadGameFromDB(gameId) {
  try {
    console.log(`[SOCKET] Loading game ${gameId} from database`)
    const game = await db.collection("games").findOne({ gameId })
    if (game) {
      console.log(`[SOCKET] Game ${gameId} loaded with ${game.players.length} players, status: ${game.status}`)
      activeGames.set(gameId, game)
      return game
    }
    console.log(`[SOCKET] Game ${gameId} not found in database`)
    return null
  } catch (error) {
    console.error("Error loading game:", error)
    return null
  }
}

async function saveGameToDB(game) {
  try {
    await db.collection("games").updateOne({ gameId: game.gameId }, { $set: game }, { upsert: true })
    console.log(
      `[SOCKET] Game ${game.gameId} saved to database with ${game.players.length} players, status: ${game.status}`,
    )
  } catch (error) {
    console.error("Error saving game:", error)
  }
}

// Broadcast game update to all clients subscribed to this game
function broadcastGameUpdate(gameId) {
  const game = activeGames.get(gameId)
  if (!game) {
    console.log(`[SOCKET] Cannot broadcast update for game ${gameId}: game not found`)
    return
  }

  const sanitizedGame = sanitizeGame(game)
  console.log(
    `[SOCKET] Broadcasting game update to room ${gameId} with ${game.players.length} players, status: ${game.status}, phase: ${game.phase}, timeLeft: ${game.timeLeft}`,
  )

  // Use room broadcasting
  io.to(gameId).emit("game:update", sanitizedGame)
}

// Broadcast a message to all clients subscribed to this game
function broadcastMessage(gameId, message) {
  console.log(`[SOCKET] Broadcasting message to room ${gameId}:`, message.message)
  io.to(gameId).emit("game:message", message)
}

// Send a private message to a specific player
function sendPrivateMessage(playerId, message) {
  // Find all sockets for this player
  for (const [socketId, data] of activeConnections.entries()) {
    if (data.playerId === playerId) {
      const socket = io.sockets.sockets.get(socketId)
      if (socket) {
        socket.emit("game:message", message)
      }
    }
  }
}

// Sanitize game data for clients
function sanitizeGame(game) {
  // Create a copy to avoid modifying the original
  const sanitized = JSON.parse(JSON.stringify(game))

  // Remove MongoDB specific fields
  delete sanitized._id

  return sanitized
}

// Socket.io connection handling
io.on("connection", async (socket) => {
  const { gameId, playerId } = socket.handshake.query

  console.log(`[SOCKET] Socket ${socket.id} connected for game ${gameId}, player ${playerId}`)

  // Store connection info
  activeConnections.set(socket.id, { gameId, playerId })

  // Join the game room
  socket.join(gameId)

  // Handle game join
  socket.on("game:join", async ({ gameId }) => {
    console.log(`[SOCKET] Player ${playerId} joining game ${gameId}`)

    let game = activeGames.get(gameId)

    if (!game) {
      game = await loadGameFromDB(gameId)
      if (!game) {
        socket.emit("game:error", "Game not found")
        return
      }
    }

    // Send game state to the client
    socket.emit("game:update", sanitizeGame(game))
  })

  // Handle game start request
  socket.on("game:start", async ({ gameId }) => {
    console.log(`[SOCKET] Received game:start request for game ${gameId} from player ${playerId}`)

    try {
      const game = await loadGameFromDB(gameId)
      if (!game) {
        socket.emit("game:error", "Game not found")
        return
      }

      if (game.host.id !== playerId) {
        socket.emit("game:error", "Only the host can start the game")
        return
      }

      if (game.status !== "waiting" && game.status !== "playing") {
        socket.emit("game:error", `Game cannot be started. Current status: ${game.status}`)
        return
      }

      if (game.players.length < 5) {
        socket.emit("game:error", `Need at least 5 players to start. Current: ${game.players.length}`)
        return
      }

      // Update game status
      game.status = "playing"
      game.startedAt = new Date()

      // Assign roles if not already assigned
      if (!game.players[0].role) {
        const players = [...game.players]
        const roles = generateRoles(game.settings, players.length)

        // Shuffle roles
        for (let i = roles.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
            ;[roles[i], roles[j]] = [roles[j], roles[i]]
        }

        // Assign roles to players
        game.players = players.map((player, index) => ({
          ...player,
          role: roles[index],
        }))
      }

      // Set up initial game state
      game.phase = "night"
      game.round = 1
      game.timeLeft = 30
      game.nightActions = {
        werewolf: null,
        doctor: null,
        seer: null,
      }
      game.dayAction = null
      game.votes = {}
      game.eliminations = []

      // Save to database
      await saveGameToDB(game)

      // Update active games cache
      activeGames.set(gameId, game)

      // Broadcast game started
      io.to(gameId).emit("game:started")
      io.to(gameId).emit("game:update", sanitizeGame(game))

      // Send system message
      const systemMessage = {
        id: Date.now().toString(),
        sender: "System",
        message: "The game has started! Night phase begins...",
        isSystem: true,
        timestamp: Date.now(),
      }
      io.to(gameId).emit("game:message", systemMessage)

      // Start the game timer
      startGameTimer(gameId)
    } catch (error) {
      console.error(`[SOCKET] Error starting game ${gameId}:`, error)
      socket.emit("game:error", `Failed to start game: ${error.message}`)
    }
  })

  // Handle player joining
  socket.on("player:join", async ({ gameId, playerName }) => {
    console.log(`[SOCKET] New player ${playerName} (${playerId}) joining game ${gameId}`)

    let game = activeGames.get(gameId)
    if (!game) {
      game = await loadGameFromDB(gameId)
      if (!game) {
        socket.emit("game:error", "Game not found")
        return
      }
    }

    if (game.status !== "waiting") {
      socket.emit("game:error", "Game has already started")
      return
    }

    if (game.players.length >= game.settings.totalPlayers) {
      socket.emit("game:error", "Game is full")
      return
    }

    const existingPlayer = game.players.find((p) => p.id === playerId)
    if (existingPlayer) {
      socket.emit("game:update", sanitizeGame(game))
      return
    }

    game.players.push({
      id: playerId,
      name: playerName,
      role: null,
      isAlive: true,
      isRevealed: false,
    })

    await saveGameToDB(game)
    broadcastGameUpdate(gameId)

    const systemMessage = {
      id: Date.now().toString(),
      sender: "System",
      message: `${playerName} has joined the game.`,
      isSystem: true,
      timestamp: Date.now(),
    }
    io.to(gameId).emit("game:message", systemMessage)
  })

  // Handle game actions
  socket.on("game:action", async ({ action, target, playerId }) => {
    const connectionData = activeConnections.get(socket.id)
    if (!connectionData) return

    const { gameId } = connectionData
    const game = activeGames.get(gameId)
    if (!game || game.status !== "playing") return

    const player = game.players.find((p) => p.id === playerId)
    if (!player || !player.isAlive) return

    console.log(`[SOCKET] Player ${player.name} performing action: ${action} on ${target}`)

    switch (action) {
      case "vote":
        if (game.phase === "day" && game.dayAction === "vote") {
          game.votes[playerId] = target

          const systemMessage = {
            id: Date.now().toString(),
            sender: "System",
            message: `${player.name} has voted.`,
            isSystem: true,
            timestamp: Date.now(),
          }
          broadcastMessage(gameId, systemMessage)

          // Check if everyone has voted
          const alivePlayers = game.players.filter((p) => p.isAlive)
          const voteCount = Object.keys(game.votes).length

          if (voteCount >= alivePlayers.length) {
            clearGameTimer(gameId)
            await handleDayEnd(game)
          } else {
            await saveGameToDB(game)
            broadcastGameUpdate(gameId)
          }
        }
        break

      case "attack":
        if (game.phase === "night" && player.role === "werewolf" && game.nightActions.werewolf === null) {
          game.nightActions.werewolf = target

          const werewolves = game.players.filter((p) => p.role === "werewolf" && p.isAlive)
          werewolves.forEach((wolf) => {
            const targetPlayer = game.players.find((p) => p.id === target)
            const privateMessage = {
              id: Date.now().toString() + wolf.id,
              sender: "System",
              message: `The werewolves have chosen to attack ${targetPlayer.name}.`,
              isSystem: true,
              timestamp: Date.now(),
            }
            sendPrivateMessage(wolf.id, privateMessage)
          })

          await checkNightActionsComplete(game)
        }
        break

      case "protect":
        if (game.phase === "night" && player.role === "doctor" && game.nightActions.doctor === null) {
          game.nightActions.doctor = target

          const targetPlayer = game.players.find((p) => p.id === target)
          const privateMessage = {
            id: Date.now().toString() + player.id,
            sender: "System",
            message: `You have chosen to protect ${targetPlayer.name}.`,
            isSystem: true,
            timestamp: Date.now(),
          }
          sendPrivateMessage(player.id, privateMessage)

          await checkNightActionsComplete(game)
        }
        break

      case "investigate":
        if (game.phase === "night" && player.role === "seer" && game.nightActions.seer === null) {
          game.nightActions.seer = target

          const targetPlayer = game.players.find((p) => p.id === target)
          const privateMessage = {
            id: Date.now().toString() + player.id,
            sender: "System",
            message: `You have chosen to investigate ${targetPlayer.name}.`,
            isSystem: true,
            timestamp: Date.now(),
          }
          sendPrivateMessage(player.id, privateMessage)

          await checkNightActionsComplete(game)
        }
        break
    }
  })

  // Handle chat messages
  socket.on("game:chat", async ({ playerId, message }) => {
    const connectionData = activeConnections.get(socket.id)
    if (!connectionData) return

    const { gameId } = connectionData
    const game = activeGames.get(gameId)
    if (!game) return

    const player = game.players.find((p) => p.id === playerId)
    if (!player) return

    // Only allow chat during day phase and if player is alive
    if (game.phase === "night" || !player.isAlive) {
      socket.emit("game:error", "You cannot chat at this time")
      return
    }

    const chatMessage = {
      id: Date.now().toString(),
      sender: player.name,
      message,
      isSystem: false,
      timestamp: Date.now(),
    }

    broadcastMessage(gameId, chatMessage)
  })

  // Handle disconnection
  socket.on("disconnect", () => {
    const connectionData = activeConnections.get(socket.id)
    if (!connectionData) return

    const { gameId, playerId } = connectionData
    console.log(`[SOCKET] Socket ${socket.id} disconnected (Player ${playerId}, Game ${gameId})`)

    activeConnections.delete(socket.id)
  })
})

// Helper functions
function generateRoles(settings, playerCount) {
  const roles = []

  for (let i = 0; i < settings.werewolves; i++) {
    roles.push("werewolf")
  }

  for (let i = 0; i < settings.doctors; i++) {
    roles.push("doctor")
  }

  for (let i = 0; i < settings.seers; i++) {
    roles.push("seer")
  }

  const villagersCount = playerCount - roles.length
  for (let i = 0; i < villagersCount; i++) {
    roles.push("villager")
  }

  return roles
}

async function checkNightActionsComplete(game) {
  if (game.phase !== "night") return

  let requiredActions = 0
  let completedActions = 0

  const aliveWerewolves = game.players.filter((p) => p.role === "werewolf" && p.isAlive)
  if (aliveWerewolves.length > 0) {
    requiredActions++
    if (game.nightActions.werewolf !== null) completedActions++
  }

  const aliveDoctors = game.players.filter((p) => p.role === "doctor" && p.isAlive)
  if (aliveDoctors.length > 0) {
    requiredActions++
    if (game.nightActions.doctor !== null) completedActions++
  }

  const aliveSeers = game.players.filter((p) => p.role === "seer" && p.isAlive)
  if (aliveSeers.length > 0) {
    requiredActions++
    if (game.nightActions.seer !== null) completedActions++
  }

  console.log(`[SOCKET] Night actions: ${completedActions}/${requiredActions} complete`)

  if (requiredActions > 0 && completedActions >= requiredActions) {
    console.log(`[SOCKET] All night actions complete, ending night phase`)
    clearGameTimer(game.gameId)
    await handleNightEnd(game)
  } else {
    await saveGameToDB(game)
    broadcastGameUpdate(game.gameId)
  }
}

async function handleNightEnd(game) {
  const gameId = game.gameId
  console.log(`[SOCKET] Handling night end for game ${gameId}`)

  const { werewolf: attackedId, doctor: protectedId, seer: investigatedId } = game.nightActions

  // Process werewolf attack
  let eliminated = null
  if (attackedId && attackedId !== protectedId) {
    const attackedPlayer = game.players.find((p) => p.id === attackedId)
    if (attackedPlayer) {
      attackedPlayer.isAlive = false
      eliminated = {
        player: attackedPlayer,
        round: game.round,
        cause: "werewolf",
      }
      game.eliminations.push(eliminated)

      const systemMessage = {
        id: Date.now().toString(),
        sender: "System",
        message: `${attackedPlayer.name} was killed during the night!`,
        isSystem: true,
        timestamp: Date.now(),
      }
      broadcastMessage(gameId, systemMessage)
    }
  }

  // Process seer investigation
  if (investigatedId) {
    const investigatedPlayer = game.players.find((p) => p.id === investigatedId)
    if (investigatedPlayer) {
      investigatedPlayer.isRevealed = true

      const seers = game.players.filter((p) => p.role === "seer" && p.isAlive)
      seers.forEach((seer) => {
        const privateMessage = {
          id: Date.now().toString() + seer.id,
          sender: "System",
          message: `You investigated ${investigatedPlayer.name} and discovered they are a ${investigatedPlayer.role}!`,
          isSystem: true,
          timestamp: Date.now(),
        }
        sendPrivateMessage(seer.id, privateMessage)
      })
    }
  }

  // Check win condition
  const winner = checkWinCondition(game)
  if (winner) {
    game.status = "finished"
    game.winner = winner
    game.finishedAt = new Date()

    const systemMessage = {
      id: Date.now().toString(),
      sender: "System",
      message: `Game over! The ${winner} have won!`,
      isSystem: true,
      timestamp: Date.now(),
    }
    broadcastMessage(gameId, systemMessage)
  } else {
    // Transition to day phase
    game.phase = "day"
    game.dayAction = "vote"
    game.votes = {}
    game.nightActions = {
      werewolf: null,
      doctor: null,
      seer: null,
    }

    const systemMessage = {
      id: Date.now().toString(),
      sender: "System",
      message: "The sun rises. The village wakes up to discuss who might be a werewolf.",
      isSystem: true,
      timestamp: Date.now(),
    }
    broadcastMessage(gameId, systemMessage)

    startGameTimer(gameId)
  }

  await saveGameToDB(game)
  broadcastGameUpdate(gameId)
}

async function handleDayEnd(game) {
  const gameId = game.gameId
  console.log(`[SOCKET] Handling day end for game ${gameId}`)

  const votes = game.votes
  const voteCounts = {}

  Object.values(votes).forEach((targetId) => {
    voteCounts[targetId] = (voteCounts[targetId] || 0) + 1
  })

  let maxVotes = 0
  let eliminatedId = null

  Object.entries(voteCounts).forEach(([playerId, count]) => {
    if (count > maxVotes) {
      maxVotes = count
      eliminatedId = playerId
    }
  })

  if (eliminatedId) {
    const eliminatedPlayer = game.players.find((p) => p.id === eliminatedId)
    if (eliminatedPlayer) {
      eliminatedPlayer.isAlive = false

      game.eliminations.push({
        player: eliminatedPlayer,
        round: game.round,
        cause: "vote",
      })

      const systemMessage = {
        id: Date.now().toString(),
        sender: "System",
        message: `The village has voted to eliminate ${eliminatedPlayer.name}, who was a ${eliminatedPlayer.role}!`,
        isSystem: true,
        timestamp: Date.now(),
      }
      broadcastMessage(gameId, systemMessage)
    }
  } else {
    const systemMessage = {
      id: Date.now().toString(),
      sender: "System",
      message: "The village couldn't decide on anyone to eliminate.",
      isSystem: true,
      timestamp: Date.now(),
    }
    broadcastMessage(gameId, systemMessage)
  }

  const winner = checkWinCondition(game)
  if (winner) {
    game.status = "finished"
    game.winner = winner
    game.finishedAt = new Date()

    const systemMessage = {
      id: Date.now().toString(),
      sender: "System",
      message: `Game over! The ${winner} have won!`,
      isSystem: true,
      timestamp: Date.now(),
    }
    broadcastMessage(gameId, systemMessage)
  } else {
    // Transition to night phase
    game.phase = "night"
    game.round += 1
    game.votes = {}
    game.nightActions = {
      werewolf: null,
      doctor: null,
      seer: null,
    }

    const systemMessage = {
      id: Date.now().toString(),
      sender: "System",
      message: "Night falls. The village goes to sleep while the werewolves hunt.",
      isSystem: true,
      timestamp: Date.now(),
    }
    broadcastMessage(gameId, systemMessage)

    startGameTimer(gameId)
  }

  await saveGameToDB(game)
  broadcastGameUpdate(gameId)
}

function checkWinCondition(game) {
  const alivePlayers = game.players.filter((player) => player.isAlive)
  const aliveWerewolves = alivePlayers.filter((player) => player.role === "werewolf")
  const aliveVillagers = alivePlayers.filter((player) => player.role !== "werewolf")

  if (aliveWerewolves.length >= aliveVillagers.length) {
    return "werewolves"
  }

  if (aliveWerewolves.length === 0) {
    return "villagers"
  }

  return null
}

function startGameTimer(gameId) {
  const game = activeGames.get(gameId)
  if (!game) return

  // Clear any existing timer
  clearGameTimer(gameId)

  // Set phase duration
  const phaseDuration = game.phase === "night" ? 30 : 120
  game.timeLeft = phaseDuration

  console.log(`[SOCKET] Starting timer for game ${gameId}, phase: ${game.phase}, duration: ${phaseDuration}s`)

  // Start the timer
  const timerId = setInterval(async () => {
    game.timeLeft -= 1
    console.log(`[SOCKET] Game ${gameId} timer: ${game.timeLeft}s remaining`)

    // Broadcast time update every 5 seconds or when time is low
    if (game.timeLeft % 5 === 0 || game.timeLeft <= 10) {
      broadcastGameUpdate(gameId)
    }

    // Phase is over
    if (game.timeLeft <= 0) {
      console.log(`[SOCKET] Timer expired for game ${gameId}, phase: ${game.phase}`)
      clearGameTimer(gameId)

      if (game.phase === "night") {
        await handleNightEnd(game)
      } else {
        await handleDayEnd(game)
      }
    }
  }, 1000)

  gameTimers.set(gameId, timerId)
}

function clearGameTimer(gameId) {
  const timerId = gameTimers.get(gameId)
  if (timerId) {
    clearInterval(timerId)
    gameTimers.delete(gameId)
    console.log(`[SOCKET] Cleared timer for game ${gameId}`)
  }
}

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    connections: io.engine.clientsCount,
    activeGames: activeGames.size,
    activeTimers: gameTimers.size,
  })
})

// Start the server
const PORT = process.env.PORT || 3001

async function startServer() {
  await connectToMongoDB()

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`)
  })
}

startServer()

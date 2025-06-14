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
    `[SOCKET] Broadcasting game update to room ${gameId} with ${game.players.length} players, status: ${game.status}`,
  )

  // Use room broadcasting
  io.to(gameId).emit("game:update", sanitizedGame)
  console.log(`[SOCKET] Broadcast complete for game ${gameId}`)
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
  delete sanitized.timer

  return sanitized
}

// Add this function to the server.js file to help with debugging
function logGameState(gameId) {
  const game = activeGames.get(gameId)
  if (!game) {
    console.log(`[SOCKET] Game ${gameId} not found in active games`)
    return
  }

  console.log(`[SOCKET] Game ${gameId} state:`)
  console.log(`[SOCKET] - Status: ${game.status}`)
  console.log(`[SOCKET] - Host: ${game.host.name} (${game.host.id})`)
  console.log(`[SOCKET] - Players (${game.players.length}):`)
  game.players.forEach((player, index) => {
    console.log(`[SOCKET]   ${index + 1}. ${player.name} (${player.id})`)
  })
}

// Socket.io connection handling
io.on("connection", async (socket) => {
  const { gameId, playerId } = socket.handshake.query

  console.log(`[SOCKET] Socket ${socket.id} connected for game ${gameId}, player ${playerId}`)
  console.log(`[SOCKET] Total connections: ${io.engine.clientsCount}`)

  // Store connection info
  activeConnections.set(socket.id, { gameId, playerId })

  // Join the game room
  socket.join(gameId)
  console.log(`[SOCKET] Socket ${socket.id} joined room ${gameId}`)

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

    // Send game state to the client that just joined
    socket.emit("game:update", sanitizeGame(game))
    console.log(`[SOCKET] Sent game state to player ${playerId}, status: ${game.status}`)

    // Also broadcast to all other clients to ensure everyone has the latest state
    socket.to(gameId).emit("game:update", sanitizeGame(game))
    console.log(`[SOCKET] Broadcast game state to other players in room ${gameId}`)
  })

  // Handle game start request
  socket.on("game:start", async ({ gameId }) => {
    console.log(`[SOCKET] Received game:start request for game ${gameId} from player ${playerId}`)

    // First, reload the game from database to get the latest state
    const game = await loadGameFromDB(gameId)
    if (!game) {
      console.log(`[SOCKET] Game ${gameId} not found in database`)
      socket.emit("game:error", "Game not found")
      return
    }

    console.log(`[SOCKET] Game ${gameId} current status: ${game.status}`)

    // Check if the player is the host
    if (game.host.id !== playerId) {
      console.log(`[SOCKET] Player ${playerId} is not the host of game ${gameId}`)
      socket.emit("game:error", "Only the host can start the game")
      return
    }

    // Check if game is in the right status (either waiting or playing from server action)
    if (game.status !== "waiting" && game.status !== "playing") {
      console.log(`[SOCKET] Game ${gameId} has invalid status: ${game.status}`)
      socket.emit("game:error", "Game cannot be started")
      return
    }

    // Check minimum players
    if (game.players.length < 5) {
      console.log(`[SOCKET] Game ${gameId} has insufficient players: ${game.players.length}`)
      socket.emit("game:error", "Need at least 5 players to start")
      return
    }

    console.log(`[SOCKET] Starting game ${gameId} with ${game.players.length} players`)

    try {
      // If the game status is already "playing" from server action, we just need to set up the game state
      if (game.status === "playing" && !game.phase) {
        console.log(`[SOCKET] Game ${gameId} was marked as playing by server action, setting up game state`)
      } else if (game.status === "waiting") {
        console.log(`[SOCKET] Game ${gameId} is in waiting state, updating to playing`)
        game.status = "playing"
        game.startedAt = new Date()
      }

      // Assign roles if not already assigned
      if (!game.players[0].role) {
        console.log(`[SOCKET] Assigning roles for game ${gameId}`)
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

      // Set up game state
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

      console.log(`[SOCKET] Game ${gameId} started successfully`)

      // Broadcast game started event
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
      socket.emit("game:error", "Failed to start game")
    }
  })

  // Handle player joining the game (from the join page)
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

    // Check if game is still in waiting status
    if (game.status !== "waiting") {
      socket.emit("game:error", "Game has already started")
      return
    }

    // Check if player limit reached
    if (game.players.length >= game.settings.totalPlayers) {
      socket.emit("game:error", "Game is full")
      return
    }

    // Check if player already exists (by ID)
    const existingPlayer = game.players.find((p) => p.id === playerId)
    if (existingPlayer) {
      console.log(`[SOCKET] Player ${playerName} (${playerId}) already in game`)
      socket.emit("game:update", sanitizeGame(game))
      return
    }

    // Add player to the game
    game.players.push({
      id: playerId,
      name: playerName,
      role: null,
      isAlive: true,
      isRevealed: false,
    })

    // Save game to database
    await saveGameToDB(game)

    // Log the game state after adding the player
    logGameState(gameId)

    // Broadcast updated game state to all clients
    broadcastGameUpdate(gameId)

    // Send system message
    const systemMessage = {
      id: Date.now().toString(),
      sender: "System",
      message: `${playerName} has joined the game.`,
      isSystem: true,
      timestamp: Date.now(),
    }
    io.to(gameId).emit("game:message", systemMessage)
  })

  // Handle game actions (vote, attack, protect, investigate)
  socket.on("game:action", async ({ action, target, playerId }) => {
    const connectionData = activeConnections.get(socket.id)
    if (!connectionData) return

    const { gameId } = connectionData
    const game = activeGames.get(gameId)
    if (!game || game.status !== "playing") return

    // Find the player
    const player = game.players.find((p) => p.id === playerId)
    if (!player || !player.isAlive) return

    // Handle different actions
    switch (action) {
      case "vote":
        if (game.phase === "day" && game.dayAction === "vote") {
          game.votes[playerId] = target

          // Send system message
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
            // End day phase early if everyone has voted
            clearInterval(game.timer)
            await handleDayEnd(game)
          } else {
            // Save and broadcast game state
            await saveGameToDB(game)
            broadcastGameUpdate(gameId)
          }
        }
        break

      case "attack":
        if (game.phase === "night" && player.role === "werewolf" && game.nightActions.werewolf === null) {
          game.nightActions.werewolf = target

          // Send message to werewolves
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

          // Check if all night actions are complete
          checkNightActionsComplete(game)
        }
        break

      case "protect":
        if (game.phase === "night" && player.role === "doctor" && game.nightActions.doctor === null) {
          game.nightActions.doctor = target

          // Send confirmation to doctor
          const targetPlayer = game.players.find((p) => p.id === target)
          const privateMessage = {
            id: Date.now().toString() + player.id,
            sender: "System",
            message: `You have chosen to protect ${targetPlayer.name}.`,
            isSystem: true,
            timestamp: Date.now(),
          }
          sendPrivateMessage(player.id, privateMessage)

          // Check if all night actions are complete
          checkNightActionsComplete(game)
        }
        break

      case "investigate":
        if (game.phase === "night" && player.role === "seer" && game.nightActions.seer === null) {
          game.nightActions.seer = target

          // Send confirmation to seer
          const targetPlayer = game.players.find((p) => p.id === target)
          const privateMessage = {
            id: Date.now().toString() + player.id,
            sender: "System",
            message: `You have chosen to investigate ${targetPlayer.name}.`,
            isSystem: true,
            timestamp: Date.now(),
          }
          sendPrivateMessage(player.id, privateMessage)

          // Check if all night actions are complete
          checkNightActionsComplete(game)
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

    // Find the player
    const player = game.players.find((p) => p.id === playerId)
    if (!player) return

    // Only allow chat during day phase and if player is alive
    if (game.phase === "night" || !player.isAlive) {
      socket.emit("game:error", "You cannot chat at this time")
      return
    }

    // Create and broadcast the message
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

    // Remove from active connections
    activeConnections.delete(socket.id)

    // Check if this player has other active connections
    let playerHasOtherConnections = false
    for (const [_, data] of activeConnections.entries()) {
      if (data.playerId === playerId && data.gameId === gameId) {
        playerHasOtherConnections = true
        break
      }
    }

    // Only handle player leaving if they have no other connections
    if (!playerHasOtherConnections) {
      const game = activeGames.get(gameId)
      if (game && game.status === "waiting") {
        // Remove player if they disconnect during waiting phase
        const playerIndex = game.players.findIndex((p) => p.id === playerId)

        if (playerIndex !== -1) {
          const playerName = game.players[playerIndex].name
          game.players.splice(playerIndex, 1)
          console.log(`[SOCKET] Player ${playerName} (${playerId}) removed from game ${gameId}`)

          // If host left, assign a new host
          if (game.host.id === playerId && game.players.length > 0) {
            game.host = game.players[0]
            console.log(`[SOCKET] New host assigned: ${game.host.name} (${game.host.id})`)
          }

          // If no players left, remove the game
          if (game.players.length === 0) {
            activeGames.delete(gameId)
            console.log(`[SOCKET] Game ${gameId} removed (no players left)`)
            return
          }

          // Save and broadcast updated game state
          saveGameToDB(game)
          broadcastGameUpdate(gameId)

          // Send system message
          const systemMessage = {
            id: Date.now().toString(),
            sender: "System",
            message: `${playerName} has left the game.`,
            isSystem: true,
            timestamp: Date.now(),
          }
          io.to(gameId).emit("game:message", systemMessage)
        }
      }
    }
  })
})

// Helper function to generate roles
function generateRoles(settings, playerCount) {
  const roles = []

  // Add special roles
  for (let i = 0; i < settings.werewolves; i++) {
    roles.push("werewolf")
  }

  for (let i = 0; i < settings.doctors; i++) {
    roles.push("doctor")
  }

  for (let i = 0; i < settings.seers; i++) {
    roles.push("seer")
  }

  // Fill the rest with villagers
  const villagersCount = playerCount - roles.length
  for (let i = 0; i < villagersCount; i++) {
    roles.push("villager")
  }

  return roles
}

// Helper function to check if all night actions are complete
async function checkNightActionsComplete(game) {
  if (game.phase !== "night") return

  // Count required actions
  let requiredActions = 0
  let completedActions = 0

  // Check werewolf action
  const aliveWerewolves = game.players.filter((p) => p.role === "werewolf" && p.isAlive)
  if (aliveWerewolves.length > 0) {
    requiredActions++
    if (game.nightActions.werewolf !== null) completedActions++
  }

  // Check doctor action
  const aliveDoctors = game.players.filter((p) => p.role === "doctor" && p.isAlive)
  if (aliveDoctors.length > 0) {
    requiredActions++
    if (game.nightActions.doctor !== null) completedActions++
  }

  // Check seer action
  const aliveSeers = game.players.filter((p) => p.role === "seer" && p.isAlive)
  if (aliveSeers.length > 0) {
    requiredActions++
    if (game.nightActions.seer !== null) completedActions++
  }

  // If all required actions are complete, end night phase early
  if (requiredActions > 0 && completedActions >= requiredActions) {
    clearInterval(game.timer)
    await handleNightEnd(game)
  } else {
    // Save and broadcast game state
    await saveGameToDB(game)
    broadcastGameUpdate(game.gameId)
  }
}

async function handleNightEnd(game) {
  const gameId = game.gameId
  // Process night actions
  const { werewolf: attackedId, doctor: protectedId, seer: investigatedId } = game.nightActions

  // Check if the attacked player was protected
  let eliminated = null
  if (attackedId && attackedId !== protectedId) {
    // Find the attacked player
    const attackedPlayer = game.players.find((p) => p.id === attackedId)
    if (attackedPlayer) {
      attackedPlayer.isAlive = false
      eliminated = {
        player: attackedPlayer,
        round: game.round,
        cause: "werewolf",
      }
      game.eliminations.push(eliminated)

      // Send system message
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

  // Handle seer investigation
  if (investigatedId) {
    const investigatedPlayer = game.players.find((p) => p.id === investigatedId)
    if (investigatedPlayer) {
      investigatedPlayer.isRevealed = true

      // Send private message to seer
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

    // Send game over message
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

    // Send day phase message
    const systemMessage = {
      id: Date.now().toString(),
      sender: "System",
      message: "The sun rises. The village wakes up to discuss who might be a werewolf.",
      isSystem: true,
      timestamp: Date.now(),
    }
    broadcastMessage(gameId, systemMessage)

    // Start day timer
    startGameTimer(gameId)
  }

  // Save game state
  await saveGameToDB(game)

  // Broadcast updated game state
  broadcastGameUpdate(gameId)
}

async function handleDayEnd(game) {
  const gameId = game.gameId
  // Count votes
  const votes = game.votes
  const voteCounts = {}

  Object.values(votes).forEach((targetId) => {
    voteCounts[targetId] = (voteCounts[targetId] || 0) + 1
  })

  // Find player with most votes
  let maxVotes = 0
  let eliminatedId = null

  Object.entries(voteCounts).forEach(([playerId, count]) => {
    if (count > maxVotes) {
      maxVotes = count
      eliminatedId = playerId
    }
  })

  // Eliminate player with most votes
  if (eliminatedId) {
    const eliminatedPlayer = game.players.find((p) => p.id === eliminatedId)
    if (eliminatedPlayer) {
      eliminatedPlayer.isAlive = false

      game.eliminations.push({
        player: eliminatedPlayer,
        round: game.round,
        cause: "vote",
      })

      // Send system message
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
    // No one was eliminated
    const systemMessage = {
      id: Date.now().toString(),
      sender: "System",
      message: "The village couldn't decide on anyone to eliminate.",
      isSystem: true,
      timestamp: Date.now(),
    }
    broadcastMessage(gameId, systemMessage)
  }

  // Check win condition
  const winner = checkWinCondition(game)
  if (winner) {
    game.status = "finished"
    game.winner = winner
    game.finishedAt = new Date()

    // Send game over message
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

    // Send night phase message
    const systemMessage = {
      id: Date.now().toString(),
      sender: "System",
      message: "Night falls. The village goes to sleep while the werewolves hunt.",
      isSystem: true,
      timestamp: Date.now(),
    }
    broadcastMessage(gameId, systemMessage)

    // Start night timer
    startGameTimer(gameId)
  }

  // Save game state
  await saveGameToDB(game)

  // Broadcast updated game state
  broadcastGameUpdate(gameId)
}

// Check win condition
function checkWinCondition(game) {
  const alivePlayers = game.players.filter((player) => player.isAlive)
  const aliveWerewolves = alivePlayers.filter((player) => player.role === "werewolf")
  const aliveVillagers = alivePlayers.filter((player) => player.role !== "werewolf")

  // Werewolves win if they equal or outnumber villagers
  if (aliveWerewolves.length >= aliveVillagers.length) {
    return "werewolves"
  }

  // Villagers win if all werewolves are dead
  if (aliveWerewolves.length === 0) {
    return "villagers"
  }

  // Game continues
  return null
}

// Start game timer
function startGameTimer(gameId) {
  const game = activeGames.get(gameId)
  if (!game) return

  // Clear any existing timer
  if (game.timer) {
    clearInterval(game.timer)
  }

  // Set phase duration based on phase
  const phaseDuration = game.phase === "night" ? 30 : 120 // 30s for night, 120s for day
  game.timeLeft = phaseDuration

  // Start the timer
  game.timer = setInterval(async () => {
    game.timeLeft -= 1

    // Broadcast time update
    broadcastGameUpdate(gameId)

    // Phase is over
    if (game.timeLeft <= 0) {
      clearInterval(game.timer)

      if (game.phase === "night") {
        await handleNightEnd(game)
      } else {
        await handleDayEnd(game)
      }
    }
  }, 1000)
}

// Add a simple health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", connections: io.engine.clientsCount })
})

// Start the server
const PORT = process.env.PORT || 3001

async function startServer() {
  await connectToMongoDB()

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`)
    console.log(`CORS origin set to: *`)
  })
}

startServer()

const express = require("express")
const http = require("http")
const { Server } = require("socket.io")
const { MongoClient, ObjectId } = require("mongodb")
const cors = require("cors")

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI ||
  "mongodb+srv://mihirsonidev:mihir%40123@cluster0.1tah4os.mongodb.net/werewolf?retryWrites=true&w=majority";
const MONGODB_DB = process.env.MONGODB_DB || "werewolf"

let db

// Express app setup
const app = express()
app.use(cors())
const server = http.createServer(app)

// Socket.io setup with improved CORS and connection handling
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "*", // Allow any origin in development
    methods: ["GET", "POST"],
    credentials: true,
  },
  allowEIO3: true, // Allow Engine.IO version 3 compatibility
  pingTimeout: 60000, // Increase ping timeout to prevent premature disconnects
})

// Track connections by device ID to prevent duplicates
const deviceConnections = new Map()

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
    const game = await db.collection("games").findOne({ gameId })
    if (game) {
      activeGames.set(gameId, game)
      return game
    }
    return null
  } catch (error) {
    console.error("Error loading game:", error)
    return null
  }
}

async function saveGameToDB(game) {
  try {
    await db.collection("games").updateOne({ gameId: game.gameId }, { $set: game }, { upsert: true })
  } catch (error) {
    console.error("Error saving game:", error)
  }
}

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
    io.to(gameId).emit("game:update", sanitizeGame(game))

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

async function handleNightEnd(game) {
  const gameId = game.gameId // Declare gameId variable
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
      io.to(gameId).emit("game:message", systemMessage)
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
        io.to(seer.id).emit("game:message", privateMessage)
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
    io.to(gameId).emit("game:message", systemMessage)
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
    io.to(game.gameId).emit("game:message", systemMessage)

    // Start day timer
    startGameTimer(game.gameId)
  }

  // Save game state
  await saveGameToDB(game)

  // Broadcast updated game state
  io.to(game.gameId).emit("game:update", sanitizeGame(game))
}

async function handleDayEnd(game) {
  const gameId = game.gameId // Declare gameId variable
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
      io.to(gameId).emit("game:message", systemMessage)
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
    io.to(gameId).emit("game:message", systemMessage)
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
    io.to(gameId).emit("game:message", systemMessage)
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
    io.to(game.gameId).emit("game:message", systemMessage)

    // Start night timer
    startGameTimer(game.gameId)
  }

  // Save game state
  await saveGameToDB(game)

  // Broadcast updated game state
  io.to(game.gameId).emit("game:update", sanitizeGame(game))
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

// Socket.io connection handling
io.on("connection", async (socket) => {
  const { gameId, playerId, deviceId } = socket.handshake.query

  console.log(`Player ${playerId} connected to game ${gameId} from device ${deviceId}`)

  // Store this connection with its device ID
  if (deviceId) {
    deviceConnections.set(deviceId, socket.id)
  }

  // Join the game room
  socket.join(gameId)
  socket.join(playerId) // For private messages

  // Handle game join
  socket.on("game:join", async ({ gameId }) => {
    let game = activeGames.get(gameId)

    if (!game) {
      game = await loadGameFromDB(gameId)

      if (!game) {
        socket.emit("game:error", "Game not found")
        return
      }

      // Initialize game if it's in playing state
      if (game.status === "playing" && !game.timer) {
        startGameTimer(gameId)
      }
    }

    // Send game state to the client
    socket.emit("game:update", sanitizeGame(game))
  })

  // Handle game actions (vote, attack, protect, investigate)
  socket.on("game:action", async ({ action, target, playerId }) => {
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
          io.to(gameId).emit("game:message", systemMessage)

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
            io.to(gameId).emit("game:update", sanitizeGame(game))
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
            io.to(wolf.id).emit("game:message", privateMessage)
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
          io.to(player.id).emit("game:message", privateMessage)

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
          io.to(player.id).emit("game:message", privateMessage)

          // Check if all night actions are complete
          checkNightActionsComplete(game)
        }
        break
    }
  })

  // Handle chat messages
  socket.on("game:chat", async ({ playerId, message }) => {
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

    io.to(gameId).emit("game:message", chatMessage)
  })

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log(`Player ${playerId} disconnected from game ${gameId}`)

    // Remove from device connections map
    if (deviceId) {
      deviceConnections.delete(deviceId)
    }

    // If game is in waiting state, handle player leaving
    const game = activeGames.get(gameId)
    if (game && game.status === "waiting") {
      // Remove player if they disconnect during waiting phase
      const playerIndex = game.players.findIndex((p) => p.id === playerId)

      if (playerIndex !== -1) {
        game.players.splice(playerIndex, 1)

        // If host left, assign a new host
        if (game.host.id === playerId && game.players.length > 0) {
          game.host = game.players[0]
        }

        // If no players left, remove the game
        if (game.players.length === 0) {
          activeGames.delete(gameId)
          return
        }

        // Save and broadcast updated game state
        saveGameToDB(game)
        io.to(gameId).emit("game:update", sanitizeGame(game))
      }
    }
  })
})

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
    io.to(game.gameId).emit("game:update", sanitizeGame(game))
  }
}

// Start the server
const PORT = process.env.PORT || 3001

async function startServer() {
  await connectToMongoDB()

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`)
  })
}

startServer()

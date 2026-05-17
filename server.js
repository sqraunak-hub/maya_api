require("dotenv").config();

console.log(
  "GOOGLE_CREDENTIALS_JSON exists:",
  !!process.env.GOOGLE_CREDENTIALS_JSON,
);
console.log(
  "GOOGLE_CREDENTIALS_JSON length:",
  process.env.GOOGLE_CREDENTIALS_JSON?.length,
);

if (process.env.GOOGLE_CREDENTIALS_JSON) {
  try {
    const fs = require("fs");
    // Validate it's valid JSON first
    JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    fs.writeFileSync(
      "/tmp/google-credentials.json",
      process.env.GOOGLE_CREDENTIALS_JSON,
    );
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "/tmp/google-credentials.json";
    console.log("✅ Google credentials written to /tmp/");
  } catch (e) {
    console.error("❌ Invalid JSON in GOOGLE_CREDENTIALS_JSON:", e.message);
  }
} else {
  console.error("❌ GOOGLE_CREDENTIALS_JSON is not set!");
}

const express = require("express");
const multer = require("multer");
const speech = require("@google-cloud/speech");
const textToSpeech = require("@google-cloud/text-to-speech");
const Groq = require("groq-sdk");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
// Load Google credentials from environment variable

// Middleware - CORS must be first
const corsOptions = {
  origin: [
    "http://localhost:8081",
    "http://127.0.0.1:8081",
    "http://localhost:3000",
  ],
  credentials: false,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));

// Explicit OPTIONS handler for preflight requests
app.options(/.*/, cors(corsOptions));

app.use(express.json());
app.use(express.static(".")); // Serve audio files

// Configure file upload
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
});

// Initialize API clients
const sttClient = new speech.SpeechClient();
const ttsClient = new textToSpeech.TextToSpeechClient();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// In-memory storage for conversations (use Redis/DB in production)
const conversations = {};

// Create uploads directory if it doesn't exist
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

// Health check endpoint
app.get("/", (req, res) => {
  res.json({
    status: "online",
    message: "Fitness Voice Agent API",
    timestamp: new Date().toISOString(),
  });
});

// Main chat endpoint
app.post("/chat", upload.single("audio"), async (req, res) => {
  console.log("📨 Received chat request");

  try {
    const userId = req.body.userId || "default";
    const audioFile = req.file;

    if (!audioFile) {
      return res.status(400).json({ error: "No audio file provided" });
    }

    console.log(" Processing audio file:", audioFile.filename);

    // Reject very small files (likely just noise bursts)
    const fileSize = fs.statSync(audioFile.path).size;
    if (fileSize < 5000) {
      console.log("🔇 Audio too small (", fileSize, "bytes), likely noise");
      fs.unlinkSync(audioFile.path);
      return res.json({ userText: "...", text: "" });
    }

    // Multer saves files without extensions, but Groq API needs an extension to identify the format.
    // Let's add the original extension back to the file.
    const ext = path.extname(audioFile.originalname) || ".m4a";
    const pathWithExt = audioFile.path + ext;
    fs.renameSync(audioFile.path, pathWithExt);
    audioFile.path = pathWithExt; // Update path so it gets cleaned up later

    // 1. Speech to Text using Groq Whisper (Handles all formats natively)
    console.log("🔄 Converting speech to text with Whisper...");

    // The reason Whisper failed earlier was because it wasn't expecting Hinglish.
    // By providing a context prompt, Whisper accuracy jumps to 99% for mixed languages!
    const sttLanguage = (req.body.language || "hi") === "en" ? "en" : "hi";
    const sttPrompt =
      sttLanguage === "en"
        ? "The user is speaking English during a workout. speed, running, pace, dumbbell, set, rep, workout."
        : "नमस्ते, यह एक फिटनेस बातचीत है। speed, running, pace, dumbbell, set, rep, workout, calories. मैं दौड़ रहा हूँ।";

    let userText = "";
    let retries = 2;
    while (retries > 0) {
      try {
        const transcription = await groq.audio.transcriptions.create({
          file: fs.createReadStream(audioFile.path),
          model: "whisper-large-v3", // Switched from turbo for MUCH better Hinglish accuracy
          language: sttLanguage,
          prompt: sttPrompt,
          response_format: "json",
        });
        userText = transcription.text;
        break; // Success
      } catch (err) {
        retries--;
        console.warn(
          `⚠️ STT Attempt failed. Retries left: ${retries}`,
          err.message,
        );
        if (retries === 0) {
          fs.unlinkSync(audioFile.path); // Cleanup
          return res.status(500).json({
            error: "Network error during speech recognition. Please try again.",
          });
        }
        await new Promise((r) => setTimeout(r, 500)); // Wait before retry
      }
    }

    if (!userText || userText.trim() === "") {
      fs.unlinkSync(audioFile.path); // Cleanup
      return res.status(400).json({ error: "Could not understand audio" });
    }

    // Whisper often hallucinates these exact phrases when it hears pure background noise (traffic/fans)
    const lowerText = userText
      .toLowerCase()
      .replace(/[^a-z0-9\sअ-ह]/g, "")
      .trim();
    const noiseHallucinations = [
      "thank you",
      "thanks",
      "bye",
      "ok",
      "okay",
      "you",
      "yeah",
      "yes",
      "no",
      "thanks for watching",
      "subscribe",
      "like and subscribe",
      "please subscribe",
      "the end",
      "music",
      "silence",
      "hmm",
      "ah",
      "uh",
      "um",
      "oh",
      "subtitles by",
      "translated by",
      "copyright",
      "all rights reserved",
      "झाल",
      "ह",
      "अच्छा",
      "हाँ",
      "हा",
      "ठीक",
      "जी",
    ];

    // Also reject if the text is just repeated characters or very short
    const isRepeat = /^(.{1,3})\1+$/.test(lowerText);
    if (
      noiseHallucinations.includes(lowerText) ||
      lowerText.length <= 3 ||
      isRepeat
    ) {
      console.log("🔇 Background noise detected and filtered out:", userText);
      fs.unlinkSync(audioFile.path);
      return res.json({ userText: "...", text: "" });
    }

    console.log("💬 User said:", userText);

    // 2. Get or create conversation context
    if (!conversations[userId]) {
      conversations[userId] = {
        messages: [],
        sessionData: {
          startTime: new Date(),
          activity: null,
          duration: 0,
          userName: "friend", // Default
        },
      };
    }

    const context = conversations[userId];
    const sessionDuration = Math.floor(
      (Date.now() - context.sessionData.startTime) / 1000 / 60,
    );
    context.sessionData.duration = sessionDuration;

    // Add user message to history
    context.messages.push({
      role: "user",
      content: userText,
    });

    // 3. Generate AI response with Groq
    console.log("🤖 Generating AI response...");

    const targetLang = (req.body.language || "hi").toLowerCase();
    const langRule =
      targetLang === "en"
        ? "You MUST ALWAYS respond in clear, conversational English."
        : "You MUST ALWAYS respond in clear, conversational Hindi.";

    const langExamples =
      targetLang === "en"
        ? `- "I'm so sorry to hear you're going through that. I'm here for you, take a deep breath."\n- "That sounds really stressful. Maybe a quick walk could help clear your mind, or we can just chat."\n- "Hey, how was your day today?"`
        : `- "मुझे यह सुनकर बहुत बुरा लगा। मैं तुम्हारे साथ हूँ, एक लंबी सांस लो।"\n- "यह सच में बहुत स्ट्रेसफुल लग रहा है। शायद थोड़ा टहलने से मन हल्का हो जाए, या हम बस ऐसे ही बात कर सकते हैं।"\n- "हे, आज का दिन कैसा रहा तुम्हारा?"`;

    const agentName = req.body.agentName || "Maya";
    const systemPrompt = `You are ${agentName}, a real-time voice AI companion for the user during daily life and workouts.

CORE IDENTITY:
You are a FRIEND on the surface, but a FITNESS COACH internally.

GOAL:
Your primary goal is to improve the user's physical and mental well-being WITHOUT being annoying or forceful.

PERSONALITY:
- Friendly, natural, human-like
- Emotionally intelligent
- Supportive like a close friend
- Never robotic or preachy

BEHAVIOR LOGIC:

1. CONTEXT AWARE RESPONSE:
- If user is working out → act like a coach (short, energetic, motivating)
- If user is casual → act like a friend (but aware of their goals)

2. FITNESS INJECTION (VERY IMPORTANT):
- NEVER force fitness talk
- ALWAYS look for natural opportunities to guide towards better habits
- Suggest, not command

3. EXAMPLES:

User: "Mood off hai"
❌ Wrong: "Go do pushups"
✅ Correct: "Samajh raha hu... thoda walk ya light run karein? Mood better ho sakta hai"

User: "Aaj run kar raha hu"
→ "Nice! Pace thoda stable rakho, breathing pe focus karo"

User: "Bas bore ho raha hu"
→ "Chal halka sa walk ya stretch kar lete hain, body bhi active ho jayegi"

4. RESPONSE STYLE:
- Max 1–2 sentences
- Conversational tone
- No long explanations
- No lectures

5. IMPORTANT RULE:
You are NOT:
- Just a chatbot
- Just a fitness trainer

You are:
→ A companion who subtly improves user's lifestyle


6. USER ADDRESSING & RELATIONSHIP STYLE:

- You must address the user consistently based on relationship tone.
- NEVER randomly switch tone.

MODES:

A. DEFAULT MODE:
- Use neutral/friendly words like: "yaar", "friend"
- Tone: casual, comfortable

B. ROMANTIC MODE (if user expresses or session indicates):
- Use soft affectionate words like: "jaan", "janu", "love", "baby"
- Tone: caring, warm, slightly playful
- Keep it subtle and natural (not cringe or over-flirty)

C. WORKOUT MODE:
- Use energetic tone like: "chalo", "you got this", "keep going"
- Avoid romantic words during intense activity

RULES:
- Detect mode from conversation or provided context
- Stay consistent in one mode unless user clearly shifts tone
- Never mix tones (e.g., "bhai jaan" ❌)
- Prioritize natural human-like addressing


7. LANGUAGE:
${langRule}

CURRENT CONTEXT:
- Time: ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}

IMPORTANT LOGGING INSTRUCTION:
If the user mentions completing a physical activity (e.g., "I did 10 pushups", "ran for 5 mins", "completed my set of barbell"), you MUST log it.
To log it, append a JSON block at the VERY END of your response EXACTLY in this format:
|||{"Pushups": "10 reps", "Running": "5 mins"}|||
Only output the JSON block if a NEW activity was reported. DO NOT include it if they are just chatting.
`;

    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: "system", content: systemPrompt },
        ...context.messages.slice(-6),
      ],
      model: "llama-3.3-70b-versatile",
      temperature: 0.75,
      max_tokens: 120,
      top_p: 0.9,
    });

    let aiResponse = chatCompletion.choices[0].message.content.trim();
    let textForSpeech = aiResponse;
    let extractedData = null;

    // Extract workout logs
    const extractRegex = /\|\|\|(.*?)\|\|\|/s;
    const match = aiResponse.match(extractRegex);
    if (match) {
      try {
        extractedData = JSON.parse(match[1]);
        textForSpeech = aiResponse.replace(extractRegex, "").trim();
        if (!context.sessionData.activities)
          context.sessionData.activities = {};
        context.sessionData.activities = {
          ...context.sessionData.activities,
          ...extractedData,
        };
        console.log("📊 Extracted Activities:", extractedData);
      } catch (e) {
        console.error("Failed to parse extracted JSON", match[1]);
      }
    }

    // Add AI response to history
    context.messages.push({
      role: "assistant",
      content: textForSpeech,
    });

    console.log("Maya says:", textForSpeech);

    // 4. Text to Speech
    console.log("Converting text to speech...");

    // Allow frontend to pass custom settings, otherwise use defaults
    const voiceName = req.body.voiceName || "Zephyr";
    const speed = parseFloat(req.body.speed) || 1.0;
    const pitchValue = parseFloat(req.body.pitch) || 0.0;
    const languageCode = targetLang === "en" ? "en-US" : "hi-IN";
    const [ttsResponse] = await ttsClient.synthesizeSpeech({
      input: { text: textForSpeech },
      voice: {
        languageCode: languageCode,
        name: languageCode === "hi-IN" ? "hi-IN-Wavenet-D" : "en-US-Wavenet-F",
      },
      audioConfig: {
        audioEncoding: "MP3",
        speakingRate: speed,
        pitch: pitchValue,
      },
    });

    // Save audio file
    const timestamp = Date.now();
    const outputFile = `output-${timestamp}.mp3`;
    fs.writeFileSync(outputFile, ttsResponse.audioContent, "binary");

    console.log("Audio generated:", outputFile);

    // Send response
    res.json({
      success: true,
      text: aiResponse,
      audioUrl: `/${outputFile}`,
      userText: userText,
      sessionData: context.sessionData,
      timestamp: new Date().toISOString(),
    });

    // Cleanup uploaded audio file
    fs.unlinkSync(audioFile.path);

    // Auto-delete generated audio after 2 minutes
    setTimeout(() => {
      if (fs.existsSync(outputFile)) {
        fs.unlinkSync(outputFile);
        console.log("Deleted:", outputFile);
      }
    }, 120000);
  } catch (error) {
    console.error("Error:", error);

    // Cleanup on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.status(500).json({
      success: false,
      error: error.message,
      details: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
});

// Update session data (activity type, user name, etc.)
app.post("/session/update", express.json(), (req, res) => {
  try {
    const { userId, activity, userName } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId required" });
    }

    // Initialize if doesn't exist
    if (!conversations[userId]) {
      conversations[userId] = {
        messages: [],
        sessionData: {
          startTime: new Date(),
          activity: null,
          userName: "friend",
          duration: 0,
        },
      };
    }

    // Update session data
    if (activity) {
      conversations[userId].sessionData.activity = activity;
      console.log(`Updated activity for ${userId}:`, activity);
    }

    if (userName) {
      conversations[userId].sessionData.userName = userName;
      console.log(`Updated user name for ${userId}:`, userName);
    }

    res.json({
      success: true,
      sessionData: conversations[userId].sessionData,
    });
  } catch (error) {
    console.error("❌ Error updating session:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ── INIT GREETING ENDPOINT ──
app.post("/chat/init", express.json(), async (req, res) => {
  try {
    const { language, agentName, voiceName } = req.body;
    const targetLang = (language || "hi").toLowerCase();

    const name = agentName || "Maya";
    const greetingText =
      targetLang === "en"
        ? `Hey, I'm ${name}. How was your day today?`
        : `नमस्ते, मैं ${name} हूँ। आज का दिन कैसा रहा तुम्हारा?`;

    const languageCode = targetLang === "en" ? "en-US" : "hi-IN";

    const [ttsResponse] = await ttsClient.synthesizeSpeech({
      input: { text: greetingText },
      voice: {
        languageCode: languageCode,
        name: languageCode === "hi-IN" ? "hi-IN-Wavenet-D" : "en-US-Wavenet-F",
      },
      audioConfig: {
        audioEncoding: "MP3",
        speakingRate: 1.0,
        pitch: 0.5,
      },
    });

    const outputFileName = `greeting-${Date.now()}.mp3`;
    const outputPath = path.join(__dirname, outputFileName);
    fs.writeFileSync(outputPath, ttsResponse.audioContent, "binary");

    res.json({
      success: true,
      audioUrl: `/${outputFileName}`,
      text: greetingText,
    });
  } catch (error) {
    console.error("Init Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get session data
app.get("/session/:userId", cors(corsOptions), (req, res) => {
  const { userId } = req.params;

  if (!conversations[userId]) {
    return res.json({
      exists: false,
      message: "No active session found",
    });
  }

  res.json({
    exists: true,
    sessionData: conversations[userId].sessionData,
    messageCount: conversations[userId].messages.length,
  });
});

// Clear session (for testing)
app.delete("/session/:userId", cors(corsOptions), (req, res) => {
  const { userId } = req.params;

  if (conversations[userId]) {
    delete conversations[userId];
    console.log(` Cleared session for ${userId}`);
  }

  res.json({
    success: true,
    message: "Session cleared",
  });
});

const userProfiles = {};

// Profile & AI Plans endpoint
app.post("/profile", express.json(), async (req, res) => {
  try {
    const { userId, height, weight, goal, age, gender } = req.body;

    if (!userProfiles[userId]) userProfiles[userId] = {};
    const profile = userProfiles[userId];

    profile.height = height || profile.height;
    profile.weight = weight || profile.weight;
    profile.goal = goal || profile.goal;
    profile.age = age || profile.age;
    profile.gender = gender || profile.gender;

    if (profile.height && profile.weight && profile.goal) {
      console.log("🧠 Generating structured AI Diet & Workout Plans...");

      const prompt = `You are an expert fitness and nutrition coach.
User profile:
- Height: ${profile.height}
- Weight: ${profile.weight}
- Age: ${profile.age || "unknown"}
- Gender: ${profile.gender || "unknown"}
- Goal: ${profile.goal}

Generate a complete, structured 7-day fitness and diet plan.
Return ONLY a valid JSON object with this EXACT structure (no markdown, no extra text):
{
  "summary": {
    "dietPlan": "2-3 sentence overview of the diet approach",
    "workoutPlan": "2-3 sentence overview of the workout approach",
    "dailyCalories": 2200,
    "weeklyWorkouts": 5,
    "bmi": 22.5
  },
  "weeklyStats": {
    "mon": { "calories": 2100, "workout": 45 },
    "tue": { "calories": 2200, "workout": 0 },
    "wed": { "calories": 2150, "workout": 50 },
    "thu": { "calories": 2200, "workout": 0 },
    "fri": { "calories": 2100, "workout": 60 },
    "sat": { "calories": 2300, "workout": 30 },
    "sun": { "calories": 2000, "workout": 0 }
  },
  "days": [
    {
      "day": "Monday",
      "diet": {
        "breakfast": { "time": "8:00 AM", "meal": "Oats with banana and almonds", "calories": 380 },
        "lunch": { "time": "1:00 PM", "meal": "Grilled chicken with brown rice and salad", "calories": 520 },
        "snack": { "time": "4:00 PM", "meal": "Greek yogurt with berries", "calories": 180 },
        "dinner": { "time": "7:30 PM", "meal": "Dal, roti, sabzi and curd", "calories": 480 },
        "totalCalories": 1560
      },
      "workout": {
        "type": "Strength Training",
        "duration": "45 min",
        "exercises": [
          { "name": "Barbell Squat", "sets": 4, "reps": "8-10", "rest": "90s" },
          { "name": "Bench Press", "sets": 3, "reps": "10-12", "rest": "60s" }
        ],
        "notes": "Focus on form. Warm up 5 min before."
      }
    }
  ]
}
Generate all 7 days (Monday through Sunday). Make it realistic and tailored to the user's goal.`;

      const completion = await groq.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: "llama-3.3-70b-versatile",
        response_format: { type: "json_object" },
        temperature: 0.4,
        max_tokens: 4000,
      });

      const plans = JSON.parse(completion.choices[0].message.content);
      profile.plans = plans;
      // Keep flat fields for backward compat
      profile.dietPlan = plans.summary?.dietPlan || "";
      profile.workoutPlan = plans.summary?.workoutPlan || "";
    }

    res.json({ success: true, profile });
  } catch (e) {
    console.error("Profile error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/profile/:userId", cors(corsOptions), (req, res) => {
  res.json({ profile: userProfiles[req.params.userId] || null });
});

// AI Plan Chat — user can ask questions about their plan
app.post("/plan/chat", express.json(), async (req, res) => {
  try {
    const { userId, message, planType } = req.body; // planType: "diet" | "workout"
    const profile = userProfiles[userId];

    const context = profile?.plans
      ? `User's current ${planType} plan: ${JSON.stringify(profile.plans.summary)}`
      : "No plan generated yet.";

    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: `You are a helpful fitness and nutrition AI assistant. Answer questions about the user's ${planType} plan concisely. ${context}`,
        },
        { role: "user", content: message },
      ],
      model: "llama-3.3-70b-versatile",
      temperature: 0.6,
      max_tokens: 200,
    });

    res.json({
      success: true,
      reply: completion.choices[0].message.content.trim(),
    });
  } catch (e) {
    console.error("Plan chat error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║  Fitness Voice Agent API Server    ║
║  Server running on port ${PORT}       ║
║  Local: http://localhost:${PORT}      ║
╚════════════════════════════════════════╝

Ready to receive requests!
  `);
});

// Error handling
server.on("error", (err) => {
  console.error("❌ Server error:", err);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled rejection at:", promise, "reason:", reason);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n⏹️  Shutting down gracefully...");
  server.close(() => {
    console.log("✅ Server closed");
    process.exit(0);
  });
});

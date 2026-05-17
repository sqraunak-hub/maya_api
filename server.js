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

// ──────────────────────────────────────────────
// GEMINI TTS WITH EMOTION DETECTION
// ──────────────────────────────────────────────
function getEmotionPrompt(text) {
  const lower = text.toLowerCase();
  if (
    lower.includes("chalo") ||
    lower.includes("you got this") ||
    lower.includes("let's go") ||
    lower.includes("keep going") ||
    lower.includes("come on") ||
    lower.includes("push") ||
    lower.includes("lete hain")
  )
    return "Read aloud with high energy and motivation, like a fitness coach!";
  if (
    lower.includes("samajh") ||
    lower.includes("bura") ||
    lower.includes("sorry") ||
    lower.includes("theek ho") ||
    lower.includes("tension") ||
    lower.includes("stress") ||
    lower.includes("i'm here")
  )
    return "Read aloud softly and with empathy and warmth.";
  if (
    lower.includes("amazing") ||
    lower.includes("great") ||
    lower.includes("bahut accha") ||
    lower.includes("fantastic") ||
    lower.includes("well done") ||
    text.includes("!")
  )
    return "Read aloud with excitement and enthusiasm.";
  if (
    lower.includes("jaan") ||
    lower.includes("janu") ||
    lower.includes("love") ||
    lower.includes("baby")
  )
    return "Read aloud in a warm, caring and affectionate tone.";
  return "Read aloud in a warm, friendly and conversational tone.";
}

async function geminiTTS(text, languageCode = "en-US") {
  const voiceName = languageCode === "hi-IN" ? "Kore" : "Zephyr";
  const emotionPrompt = getEmotionPrompt(text);

  const [ttsResponse] = await ttsClient.synthesizeSpeech({
    input: {
      prompt: emotionPrompt,
      text: text,
    },
    voice: {
      languageCode: languageCode,
      modelName: "gemini-2.5-flash-tts-preview",
      name: voiceName,
    },
    audioConfig: {
      audioEncoding: "MP3",
      speakingRate: 1.0,
      pitch: 0.0,
    },
  });

  return ttsResponse.audioContent;
}

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
    const ext = path.extname(audioFile.originalname) || ".m4a";
    const pathWithExt = audioFile.path + ext;
    fs.renameSync(audioFile.path, pathWithExt);
    audioFile.path = pathWithExt;

    // 1. Speech to Text using Groq Whisper
    console.log("🔄 Converting speech to text with Whisper...");

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
          model: "whisper-large-v3",
          language: sttLanguage,
          prompt: sttPrompt,
          response_format: "json",
        });
        userText = transcription.text;
        break;
      } catch (err) {
        retries--;
        console.warn(
          `⚠️ STT Attempt failed. Retries left: ${retries}`,
          err.message,
        );
        if (retries === 0) {
          fs.unlinkSync(audioFile.path);
          return res.status(500).json({
            error: "Network error during speech recognition. Please try again.",
          });
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    if (!userText || userText.trim() === "") {
      fs.unlinkSync(audioFile.path);
      return res.status(400).json({ error: "Could not understand audio" });
    }

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
          userName: "friend",
        },
      };
    }

    const context = conversations[userId];
    const sessionDuration = Math.floor(
      (Date.now() - context.sessionData.startTime) / 1000 / 60,
    );
    context.sessionData.duration = sessionDuration;

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

    context.messages.push({
      role: "assistant",
      content: textForSpeech,
    });

    console.log("Maya says:", textForSpeech);

    // 4. Text to Speech — Gemini with emotion
    console.log("🎙️ Converting text to speech with Gemini TTS...");

    const languageCode = targetLang === "en" ? "en-US" : "hi-IN";
    const audioContent = await geminiTTS(textForSpeech, languageCode);

    const timestamp = Date.now();
    const outputFile = `output-${timestamp}.mp3`;
    fs.writeFileSync(outputFile, audioContent, "binary");

    console.log("✅ Audio generated:", outputFile);

    res.json({
      success: true,
      text: aiResponse,
      audioUrl: `/${outputFile}`,
      userText: userText,
      sessionData: context.sessionData,
      timestamp: new Date().toISOString(),
    });

    fs.unlinkSync(audioFile.path);

    setTimeout(() => {
      if (fs.existsSync(outputFile)) {
        fs.unlinkSync(outputFile);
        console.log("🗑️ Deleted:", outputFile);
      }
    }, 120000);
  } catch (error) {
    console.error("❌ Error:", error);

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

// Update session data
app.post("/session/update", express.json(), (req, res) => {
  try {
    const { userId, activity, userName } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId required" });
    }

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

    if (activity) {
      conversations[userId].sessionData.activity = activity;
      console.log(`✅ Updated activity for ${userId}:`, activity);
    }

    if (userName) {
      conversations[userId].sessionData.userName = userName;
      console.log(`✅ Updated user name for ${userId}:`, userName);
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
    const { language, agentName } = req.body;
    const targetLang = (language || "hi").toLowerCase();

    const name = agentName || "Maya";
    const greetingText =
      targetLang === "en"
        ? `Hey, I'm ${name}. How was your day today?`
        : `नमस्ते, मैं ${name} हूँ। आज का दिन कैसा रहा तुम्हारा?`;

    const langCode = targetLang === "en" ? "en-US" : "hi-IN";
    const audioContent = await geminiTTS(greetingText, langCode);

    const outputFileName = `greeting-${Date.now()}.mp3`;
    const outputPath = path.join(__dirname, outputFileName);
    fs.writeFileSync(outputPath, audioContent, "binary");

    res.json({
      success: true,
      audioUrl: `/${outputFileName}`,
      text: greetingText,
    });
  } catch (error) {
    console.error("❌ Init Error:", error);
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

// Clear session
app.delete("/session/:userId", cors(corsOptions), (req, res) => {
  const { userId } = req.params;

  if (conversations[userId]) {
    delete conversations[userId];
    console.log(`🗑️ Cleared session for ${userId}`);
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
      profile.dietPlan = plans.summary?.dietPlan || "";
      profile.workoutPlan = plans.summary?.workoutPlan || "";
    }

    res.json({ success: true, profile });
  } catch (e) {
    console.error("❌ Profile error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/profile/:userId", cors(corsOptions), (req, res) => {
  res.json({ profile: userProfiles[req.params.userId] || null });
});

// AI Plan Chat
app.post("/plan/chat", express.json(), async (req, res) => {
  try {
    const { userId, message, planType } = req.body;
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
    console.error("❌ Plan chat error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────────
// 1. NOTIFICATIONS & REMINDERS
// ──────────────────────────────────────────────
const reminders = {};

app.post("/reminders/schedule", express.json(), (req, res) => {
  try {
    const { userId, type, time, title, message, frequency } = req.body;

    if (!reminders[userId]) reminders[userId] = [];

    const reminder = {
      id: Date.now(),
      type,
      time,
      title,
      message,
      frequency,
      active: true,
      createdAt: new Date(),
    };

    reminders[userId].push(reminder);
    console.log(`📬 Scheduled reminder for ${userId}:`, reminder.title);

    res.json({ success: true, reminder });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/reminders/:userId", cors(corsOptions), (req, res) => {
  const { userId } = req.params;
  res.json({ reminders: reminders[userId] || [] });
});

app.delete("/reminders/:userId/:reminderId", (req, res) => {
  const { userId, reminderId } = req.params;
  if (reminders[userId]) {
    reminders[userId] = reminders[userId].filter((r) => r.id != reminderId);
  }
  res.json({ success: true });
});

// ──────────────────────────────────────────────
// 2. PROGRESS ANALYTICS & DASHBOARD
// ──────────────────────────────────────────────
const analytics = {};

app.post("/analytics/log", express.json(), (req, res) => {
  try {
    const { userId, date, calories, steps, workoutMinutes, activities } =
      req.body;

    if (!analytics[userId]) analytics[userId] = [];

    const entry = {
      date: date || new Date().toISOString().split("T")[0],
      calories: calories || 0,
      steps: steps || 0,
      workoutMinutes: workoutMinutes || 0,
      activities: activities || {},
      timestamp: new Date(),
    };

    analytics[userId].push(entry);
    console.log(`📊 Logged analytics for ${userId}:`, entry);

    res.json({ success: true, entry });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/analytics/:userId", cors(corsOptions), (req, res) => {
  const { userId } = req.params;
  const { days = 30 } = req.query;

  const userAnalytics = analytics[userId] || [];
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  const filtered = userAnalytics.filter((a) => new Date(a.date) >= cutoffDate);

  const totalCalories = filtered.reduce((sum, a) => sum + a.calories, 0);
  const totalSteps = filtered.reduce((sum, a) => sum + a.steps, 0);
  const totalWorkout = filtered.reduce((sum, a) => sum + a.workoutMinutes, 0);
  const avgDaily = Math.round(totalCalories / (days || 1));

  const today = new Date();
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const checkDate = new Date(today);
    checkDate.setDate(checkDate.getDate() - i);
    const dateStr = checkDate.toISOString().split("T")[0];
    const hasWorkout = filtered.some(
      (a) => a.date === dateStr && a.workoutMinutes > 0,
    );
    if (hasWorkout) streak++;
    else break;
  }

  res.json({
    period: days,
    totalCalories,
    totalSteps,
    totalWorkoutMinutes: totalWorkout,
    avgDailyCalories: avgDaily,
    streak,
    entries: filtered,
  });
});

app.get("/analytics/:userId/weekly", cors(corsOptions), (req, res) => {
  const { userId } = req.params;
  const userAnalytics = analytics[userId] || [];

  const weekData = {};
  const weekDays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

  userAnalytics.slice(-7).forEach((entry) => {
    const date = new Date(entry.date);
    const day = weekDays[date.getDay()];
    weekData[day] = {
      calories: entry.calories,
      workout: entry.workoutMinutes,
      steps: entry.steps,
    };
  });

  res.json(weekData);
});

// ──────────────────────────────────────────────
// 3. REAL-TIME WORKOUT COACH MODE
// ──────────────────────────────────────────────
app.post("/coach/guidance", express.json(), async (req, res) => {
  try {
    const { userId, exerciseName, repsCompleted, setNumber, feedbackLang } =
      req.body;

    const langRule =
      feedbackLang === "en"
        ? "Respond in English"
        : "Respond in Hindi/Hinglish";

    const prompt = `You are Maya, a real-time fitness coach giving motivational voice feedback during a workout.
The user is doing: ${exerciseName}
Current: Set ${setNumber}, ${repsCompleted} reps completed

Give SHORT (max 1 sentence) motivational feedback. Be encouraging and energetic.
Examples:
- "Great form! Keep the pace steady!"
- "You got this! 5 more reps, let's go!"
- "Breathe! Don't hold your breath!"

${langRule}`;

    const guidance = await groq.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "llama-3.3-70b-versatile",
      temperature: 0.7,
      max_tokens: 50,
    });

    const text = guidance.choices[0].message.content.trim();

    // Gemini TTS for coach guidance
    const langCode = feedbackLang === "en" ? "en-US" : "hi-IN";
    const audioContent = await geminiTTS(text, langCode);

    const timestamp = Date.now();
    const outputFile = `coach-${timestamp}.mp3`;
    fs.writeFileSync(outputFile, audioContent, "binary");

    setTimeout(() => {
      if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
    }, 60000);

    res.json({
      success: true,
      text,
      audioUrl: `/${outputFile}`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/coach/form-tips", express.json(), async (req, res) => {
  try {
    const { exerciseName, goal, lang } = req.body;

    const prompt = `Provide 2-3 brief form tips for ${exerciseName} exercise aimed at ${goal || "general fitness"}.
Keep it very concise and actionable. Format as bullet points.
${lang === "hi" ? "Respond in Hindi" : "Respond in English"}`;

    const tips = await groq.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "llama-3.3-70b-versatile",
      temperature: 0.5,
      max_tokens: 100,
    });

    res.json({
      exercise: exerciseName,
      tips: tips.choices[0].message.content.trim(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────────
// 4. HEALTH INTEGRATION
// ──────────────────────────────────────────────
const healthData = {};

app.post("/health/sync", express.json(), (req, res) => {
  try {
    const { userId, heartRate, sleepHours, waterIntake, date } = req.body;

    if (!healthData[userId]) healthData[userId] = [];

    const entry = {
      date: date || new Date().toISOString().split("T")[0],
      heartRate: heartRate || null,
      sleepHours: sleepHours || null,
      waterIntake: waterIntake || 0,
      timestamp: new Date(),
    };

    healthData[userId].push(entry);
    console.log(`❤️ Synced health data for ${userId}`);

    res.json({ success: true, entry });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/health/:userId", cors(corsOptions), (req, res) => {
  const { userId } = req.params;
  const { days = 7 } = req.query;

  const userHealth = healthData[userId] || [];
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  const filtered = userHealth.filter((h) => new Date(h.date) >= cutoffDate);

  const avgHeartRate = Math.round(
    filtered.filter((h) => h.heartRate).reduce((s, h) => s + h.heartRate, 0) /
      Math.max(filtered.filter((h) => h.heartRate).length, 1),
  );
  const avgSleep = (
    filtered.filter((h) => h.sleepHours).reduce((s, h) => s + h.sleepHours, 0) /
    Math.max(filtered.filter((h) => h.sleepHours).length, 1)
  ).toFixed(1);
  const totalWater = filtered.reduce((s, h) => s + h.waterIntake, 0);

  res.json({
    period: days,
    avgHeartRate,
    avgSleepHours: parseFloat(avgSleep),
    totalWaterIntakeMl: totalWater,
    entries: filtered,
  });
});

// ──────────────────────────────────────────────
// 5. GAMIFICATION & ACHIEVEMENTS
// ──────────────────────────────────────────────
const userAchievements = {};

app.post("/achievements/check", express.json(), async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userAchievements[userId]) {
      userAchievements[userId] = {
        badges: [],
        points: 0,
        leaderboardRank: null,
      };
    }

    const userAnalytics = analytics[userId] || [];
    const userHealth = healthData[userId] || [];
    const userActs = userAchievements[userId];

    const newBadges = [];

    const totalWorkout = userAnalytics.reduce(
      (s, a) => s + a.workoutMinutes,
      0,
    );
    const totalCalories = userAnalytics.reduce((s, a) => s + a.calories, 0);

    let streak = 0;
    for (let i = 0; i < 365; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split("T")[0];
      const hasWorkout = userAnalytics.some(
        (a) => a.date === dateStr && a.workoutMinutes > 0,
      );
      if (hasWorkout) streak++;
      else break;
    }

    if (streak >= 7 && !userActs.badges.find((b) => b.id === "streak-7")) {
      newBadges.push({
        id: "streak-7",
        name: "🔥 7-Day Streak",
        description: "Worked out 7 days in a row",
        unlockedAt: new Date(),
      });
      userActs.points += 100;
    }

    if (
      totalCalories >= 1000 &&
      !userActs.badges.find((b) => b.id === "calorie-1000")
    ) {
      newBadges.push({
        id: "calorie-1000",
        name: "🔥 1000 Calories",
        description: "Burned 1000+ calories",
        unlockedAt: new Date(),
      });
      userActs.points += 150;
    }

    if (
      totalWorkout >= 600 &&
      !userActs.badges.find((b) => b.id === "workout-600")
    ) {
      newBadges.push({
        id: "workout-600",
        name: "💪 10 Hour Marathon",
        description: "Completed 10 hours of workouts",
        unlockedAt: new Date(),
      });
      userActs.points += 200;
    }

    const avgSleep =
      userHealth
        .filter((h) => h.sleepHours)
        .slice(-7)
        .reduce((s, h) => s + h.sleepHours, 0) /
      Math.max(userHealth.filter((h) => h.sleepHours).length, 1);

    if (avgSleep >= 7 && !userActs.badges.find((b) => b.id === "sleep-7")) {
      newBadges.push({
        id: "sleep-7",
        name: "😴 Sleep Champion",
        description: "Averaged 7+ hours of sleep",
        unlockedAt: new Date(),
      });
      userActs.points += 50;
    }

    userActs.badges = [...(userActs.badges || []), ...newBadges];

    res.json({
      newBadges,
      totalPoints: userActs.points,
      allBadges: userActs.badges,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/achievements/:userId", cors(corsOptions), (req, res) => {
  const { userId } = req.params;
  const acts = userAchievements[userId] || {
    badges: [],
    points: 0,
  };

  res.json({
    badges: acts.badges,
    points: acts.points,
    level: Math.floor(acts.points / 500) + 1,
  });
});

app.get("/leaderboard", cors(corsOptions), (req, res) => {
  const leaderboard = Object.entries(userAchievements)
    .map(([userId, acts]) => ({
      userId,
      points: acts.points,
      badgeCount: acts.badges.length,
      level: Math.floor(acts.points / 500) + 1,
    }))
    .sort((a, b) => b.points - a.points)
    .slice(0, 20);

  res.json(leaderboard);
});

// Friend/Social endpoints
const userFriends = {};

app.post("/social/add-friend", express.json(), (req, res) => {
  try {
    const { userId, friendUserId } = req.body;

    if (!userFriends[userId]) userFriends[userId] = [];
    if (!userFriends[userId].find((f) => f === friendUserId)) {
      userFriends[userId].push(friendUserId);
    }

    res.json({ success: true, message: "Friend added" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/social/friends/:userId", cors(corsOptions), (req, res) => {
  const { userId } = req.params;
  const friends = userFriends[userId] || [];

  const friendStats = friends.map((friendId) => {
    const friendActs = userAchievements[friendId];
    return {
      friendId,
      points: friendActs?.points || 0,
      badgeCount: friendActs?.badges?.length || 0,
    };
  });

  res.json(friendStats);
});

// Start server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║  Fitness Voice Agent API Server        ║
║  Server running on port ${PORT}           ║
║  Local: http://localhost:${PORT}          ║
║  TTS: Gemini 2.5 Flash (Emotional)     ║
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

process.on("SIGINT", () => {
  console.log("\n⏹️  Shutting down gracefully...");
  server.close(() => {
    console.log("✅ Server closed");
    process.exit(0);
  });
});

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();


// CORS (place BEFORE routes)
const allowedOrigins = [
  "https://builderassistant-3ml1.onrender.com",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

app.use(
  cors({
    origin(origin, cb) {
      // allow same-origin / non-browser tools with no Origin
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false, // set to true ONLY if you use cookies across origins
  })
);

// Good practice: respond to all preflights
app.options("*", cors());

// Optional: a health endpoint for Render
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// ... your routes ...

/* =====================================================
   🚀 Server Start  (Render needs process.env.PORT)
===================================================== */
const port = process.env.PORT || 5000;
app.listen(port, "0.0.0.0", () => {
  console.log(`🚀 Backend running on http://0.0.0.0:${port}`);
  if (!process.env.ASSISTANT_ID)
    console.error("⚠️ Missing ASSISTANT_ID in .env file!");
});

app.use(express.json());

/* =====================================================
   🧱 Safe Multer Disk Storage (fixes 413 & memory issues)
===================================================== */
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB max per file
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* =====================================================
   🔹 Main Chat Endpoint
===================================================== */
app.post("/api/ask", upload.array("files"), async (req, res) => {
  try {
    const { message, role, language } = req.body;
    const files = req.files || [];

    console.log("📨 Incoming message:", message);
    console.log("👤 Role:", role, "| 🌐 Lang:", language);
    console.log("📎 Uploaded files:", files.length);

    // 🧩 1️⃣ Upload files safely via streaming
    const uploadedFileIds = [];
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) {
        console.warn(`⚠️ Skipping oversized file: ${file.originalname}`);
        continue;
      }

      const stream = fs.createReadStream(file.path);
      const uploaded = await openai.files.create({
        file: stream,
        purpose: "assistants",
      });
      uploadedFileIds.push(uploaded.id);
      fs.unlink(file.path, () => {}); // async cleanup
    }

    // 🧩 2️⃣ Create thread
    const thread = await openai.beta.threads.create();
    console.log("threaddddd",thread);

    // 🧩 3️⃣ Build message with role context
    const roleContext = {
      Investor:
        "You are responding to an Investor. Keep responses high-level, focused on compliance, readiness, and confidence.",
      Designer:
        "You are responding to a Designer. Provide detailed technical and legal insights based on BEP validation rules.",
      "Site Manager":
        "You are responding to a Site Manager. Use checklist-style instructions and prioritize readiness, safety, and version control.",
      Contractor:
        "You are responding to a Contractor. Focus on deliverables, compliance, and documentation handover clarity.",
      Tradesman: "You are responding to a Tradesman — an independent craftsman or small subcontractor who uses Validorix to create, check, and manage contracts, offers, or work agreements."
    }
    const contentToSend = `
    You are a helpful assistant that validates and analyzes documents.
    Always follow these rules:
    
    🟩 If the user's message includes words like "validate", "analyze", "review", or "check", then:
    1. Perform the analysis.
    2. Return your main response (summary) **followed by** a JSON array like this:
    
    [
      {"status": "success", "text": "What was validated successfully"},
      {"status": "error", "text": "What issues or missing elements were found"},
      {"status": "warning", "text": "Any partial or uncertain validations"}
    ]
    
    🟥 If the user's message does NOT request analysis, just respond normally (no JSON).
    
    Role Context: ${roleContext[role] || "General helper."}
    ${language === "CS" ? "Please respond in Czech." : ""}
    User Message: "${message}"
    `;
    
    // 🧩 4️⃣ Post message
    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: contentToSend,
      ...(uploadedFileIds.length > 0 && {
        attachments: uploadedFileIds.map((id) => ({
          file_id: id,
          tools: [{ type: "file_search" }],
        })),
      }),
    });

    console.log("Hello I am here");

    // 🧩 5️⃣ Create a run
    if (!process.env.ASSISTANT_ID) {
      throw new Error("❌ Missing ASSISTANT_ID in environment variables.");
    }

    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: process.env.ASSISTANT_ID,
    });

    console.log("Now I am here")
    console.log("run id", run.id);
    console.log("thread id", thread.id);
    

    // 🧩 6️⃣ Poll for completion
    let runStatus = await openai.beta.threads.runs.retrieve(
      run.id,
      { thread_id: thread.id }
    );
    //let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);

    let attempts = 0;
    while (
      runStatus.status !== "completed" &&
      runStatus.status !== "failed" &&
      attempts < 60
    ) {
      console.log("⏳ Run status:", runStatus.status);
      await new Promise((r) => setTimeout(r, 1000));
      runStatus = await openai.beta.threads.runs.retrieve(run.id, {
        thread_id: thread.id,
      });
      attempts++;
    }

    if (runStatus.status !== "completed") {
      console.error("❌ Run did not complete:", runStatus.status);
      return res
        .status(504)
        .json({ reply: "⚠️ Assistant timed out.", results: [] });
    }

    // 🧩 7️⃣ Fetch assistant reply
    const response = await openai.beta.threads.messages.list(thread.id);
    const latest = response.data.find((m) => m.role === "assistant");
    const reply = latest?.content?.[0]?.text?.value || "No response received.";

    // 🧩 8️⃣ Parse optional JSON results
    const match = reply.match(/\[.*?\]/s);
    let parsedResults = [];
    if (match) {
      try {
        parsedResults = JSON.parse(match[0]);
      } catch {
        console.warn("⚠️ Could not parse JSON array.");
      }
    }

    res.json({ reply, results: parsedResults });
  } catch (err) {
    console.error("💥 Error in /api/ask:", err);
    if (err.response?.status === 413) {
      return res.status(413).json({
        reply:
          "File too large — please upload files smaller than 20MB.",
        results: [],
      });
    }

    res.status(500).json({
      reply: "Server error while contacting assistant.",
      results: [],
    });
  }
});

/* =====================================================
   🔹 Export Summary (Grok)
===================================================== */
/* =====================================================
   🔹 Export Summary (via Grok on OpenRouter)
===================================================== */
import axios from "axios";

app.post("/api/export", async (req, res) => {
  try {
    const { messages = [], analysisResults = [], role = "Investor", language = "EN" } = req.body;

    const sanitize = (s = "") =>
      String(s)
        .replace(/```[\s\S]*?```/g, "")
        .replace(/【[^】]+】/g, "")
        .replace(/\s+\n/g, "\n")
        .trim();

    const lastAssistant =
      messages.slice().reverse().find((m) => m.role === "assistant")?.content || "";

    const recent = messages
      .slice(-10)
      .map((m) => `${m.role.toUpperCase()}: ${sanitize(m.content || "")}`)
      .join("\n");

    const targetLang = language === "CS" ? "Czech" : "English";

    const contentPrompt = `
You are a professional technical report writer preparing an executive-grade summary for ${role}.
Write a concise, client-ready report in ${targetLang}.

Guidelines:
- Use plain UTF-8 text only (no Markdown, HTML, LaTeX, or special characters like *, #, &, <, >).
- Structure the report with clear section headers such as:
  Executive Summary:
  Project Overview:
  Compliance Assessment:
  Key Strengths:
  Recommendations:
- Keep paragraphs short (2–4 lines) and formatted for PDF printing.
- Do not include bullet symbols or JSON.
- Avoid ampersands (&) or encoding artifacts (like &nbsp;).
- Tone should be formal, neutral, and suitable for executives.

Context Information:
Role: ${role}
Assistant’s previous output (raw):
${sanitize(lastAssistant) || "(none)"}

Validation Results (for reference):
${JSON.stringify(analysisResults, null, 2)}

Recent conversation transcript (for additional context):
${recent}

Your task:
Rewrite and elaborate the above information into a clean, polished, professional report.
Ensure the output contains only human-readable text, properly sectioned and ready for PDF printing.
Output plain printable UTF-8 only.
`;

    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "x-ai/grok-4-fast",
        messages: [
          { role: "system", content: "You are a professional report writer." },
          { role: "user", content: contentPrompt },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "HTTP-Referer": "builderassistant-3ml1.onrender.com",
          "X-Title": "DigiStav Export (Grok)",
        },
        timeout: 60000,
      }
    );

    let summary = response?.data?.choices?.[0]?.message?.content?.trim() || "";

    // fallback if empty
    if (!summary || summary.length < 20) {
      const base = sanitize(lastAssistant);
      const resultsBlock = analysisResults.length
        ? [
            "Validation Results:",
            ...analysisResults.map(
              (i) => `- [${(i.status || "").toUpperCase()}] ${i.text}`
            ),
          ].join("\n")
        : "";
      summary = `Summary:\n${base || "No assistant response available."}\n\n${resultsBlock}`;
    }

    res.json({ summary });
  } catch (err) {
    console.error("💥 Error in /api/export (Grok):", err.response?.data || err.message);
    res.status(500).json({ summary: "Failed to generate summary using Grok." });
  }
});

/* =====================================================
   🚀 Server Start
===================================================== */
app.listen(port, () => {
  console.log(`🚀 Backend running on http://localhost:${port}`);
  if (!process.env.ASSISTANT_ID)
    console.error("⚠️ Missing ASSISTANT_ID in .env file!");
});

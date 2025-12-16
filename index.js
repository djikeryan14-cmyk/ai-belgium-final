// ==========================================
// MOTEUR SAAS AI BELGIUM - VERSION EXP (PASSE-MURAILLE)
// ==========================================
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// Initialisation
const genAI = process.env.GEMINI_API_KEY 
    ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) 
    : null;

const sb = (process.env.SUPABASE_URL && process.env.SUPABASE_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
    : null;

// --- WORKFLOW ---
const WORKFLOW_DEFINITION = {
    name: "AI_System_BE_Final_Exp",
    nodes: [
        { id: "1_normalize", type: "code.function", code: "return { ...input, timestamp: new Date(), trace_id: context.trace_id };" },
        { id: "2_memory_recall", type: "ai.memory_recall", name: "Recherche Historique", config: { query: "{{content}}" } },
        { 
            id: "3_sentiment_analysis", 
            type: "ai.analyze", 
            name: "Analyse", 
            prompt: "Analyse ce message: '{{content}}'. Retourne UNIQUEMENT un JSON brut : { \"sentiment\": score(-1 à 1), \"is_urgent\": boolean, \"intent\": string }." 
        },
        { 
            id: "4_router_brain", 
            type: "logic.router", 
            name: "Routeur", 
            routes: [
                { rule: "context['3_sentiment_analysis'].is_urgent === true", output: "99_escalation" },
                { rule: "context['3_sentiment_analysis'].intent === 'rdv'", output: "10_booking" },
                { rule: "true", output: "5_cultural_response" }
            ]
        },
        { 
            id: "5_cultural_response", 
            type: "ai.generate", 
            name: "Reponse Belge", 
            prompt: "Agis comme un assistant PME belge. Contexte: {{2_memory_recall}}. Message: {{content}}. Réponds poliment et utilement." 
        },
        { id: "99_escalation", type: "system.action", name: "Alerte", action: "send_sms_alert", payload: "Urgence détectée" }
    ]
};

// --- ENGINE ---
async function runWorkflow(inputData) {
    let context = { input: inputData, content: inputData.message || "Vide", trace_id: uuidv4(), logs: [] };
    console.log(`🚀 Start [${context.trace_id}]`);

    const nodes = WORKFLOW_DEFINITION.nodes;
    let idx = 0;
    while (idx < nodes.length) {
        const node = nodes[idx];
        try {
            let result = null;
            if (node.type === 'code.function') {
                result = new Function('input', 'context', node.code)(context.input, context);
            } else if (node.type === 'ai.memory_recall') {
                result = await searchMemory(context.content);
            } else if (node.type === 'ai.analyze' || node.type === 'ai.generate') {
                const filledPrompt = fillPrompt(node.prompt, context);
                result = await callGemini(filledPrompt, node.type === 'ai.analyze');
            } else if (node.type === 'logic.router') {
                const nextId = executeRouter(context, node.routes);
                if (nextId) {
                    const nextIdx = nodes.findIndex(n => n.id === nextId);
                    if (nextIdx !== -1) { idx = nextIdx; continue; }
                }
            } else if (node.type === 'system.action') {
                result = { status: "executed", action: node.action };
            }
            context[node.id] = result;
            context.logs.push({ node: node.id, output: result });
            idx++;
        } catch (e) { console.error(`Error Node ${node.id}`, e); break; }
    }
    await saveToMemory(context.content, context);
    return context;
}

function fillPrompt(t, c) { return t.replace(/\{\{(.*?)\}\}/g, (m, p) => { let v=c; p.split('.').forEach(k=>v=v?v[k]:undefined); return typeof v==='object'?JSON.stringify(v):(v||""); }); }
function executeRouter(c, r) { for (const route of r) { try { if(new Function('context', `return ${route.rule}`)(c)) return route.output; } catch(e){} } return null; }

// --- FONCTION GEMINI (VERSION EXPERIMENTALE 2.0) ---
async function callGemini(prompt, isJson) {
    if (!genAI) return isJson ? { sentiment: 0 } : "IA non configurée.";
    try {
        // 🔥 ESSAI AVEC LA VERSION 2.0 EXPERIMENTALE (Souvent non bloquée en Europe)
        // Si celle-ci échoue, on tentera 'gemini-1.5-flash-8b'
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
        
        const result = await model.generateContent(prompt);
        let txt = result.response.text();
        
        if (isJson) {
            txt = txt.replace(/```json/g, '').replace(/```/g, '').trim();
            try { return JSON.parse(txt); } catch (e) { return { sentiment: 0 }; }
        }
        return txt;
    } catch (e) {
        console.error("GOOGLE ERROR:", e);
        return isJson ? { sentiment: 0.5 } : "ERREUR : " + e.message;
    }
}

async function searchMemory(text) {
    if (!sb || !genAI) return "No Memory";
    try {
        const model = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const emb = await model.embedContent(text);
        const { data } = await sb.rpc('match_documents', { query_embedding: emb.embedding.values, match_threshold: 0.5, match_count: 2 });
        return data ? data.map(d=>d.content).join(" | ") : "Rien";
    } catch (e) { return "Erreur Memoire"; }
}

async function saveToMemory(text, context) {
    if (!sb || !genAI) return;
    try {
        const model = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const emb = await model.embedContent(text);
        await sb.from('documents').insert({ content: text, metadata: {trace_id: context.trace_id}, embedding: emb.embedding.values });
    } catch(e) {}
}

app.post('/webhook', async (req, res) => {
    if (!req.body.message) return res.status(400).json({ error: "No message" });
    const ctx = await runWorkflow(req.body);
    const resp = ctx['5_cultural_response'] || (ctx['99_escalation'] ? "Un manager arrive." : "Reçu.");
    res.json({ success: true, response: resp });
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));

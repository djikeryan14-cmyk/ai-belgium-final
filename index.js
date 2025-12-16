// ==========================================
// MOTEUR SAAS AI BELGIUM - VERSION INNOVATIVE
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

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;

// Initialisation sécurisée
const genAI = process.env.GEMINI_API_KEY 
    ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) 
    : null;

const sb = (process.env.SUPABASE_URL && process.env.SUPABASE_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
    : null;

// --- WORKFLOW ---
const WORKFLOW_DEFINITION = {
    name: "AI_System_BE_V9_Innovative",
    nodes: [
        {
            id: "1_normalize",
            type: "code.function",
            code: "return { ...input, timestamp: new Date(), trace_id: context.trace_id };"
        },
        {
            id: "2_memory_recall",
            type: "ai.memory_recall",
            name: "🧠 Recherche Historique",
            config: { query: "{{content}}" }
        },
        {
            id: "3_sentiment_analysis",
            type: "ai.analyze",
            name: "Analyse Sentiment & Urgence",
            prompt: "Analyse ce message: '{{content}}'. Retourne un JSON: { sentiment: score(-1 à 1), is_urgent: boolean, intent: string }."
        },
        {
            id: "4_router_brain",
            type: "logic.router",
            name: "🔀 Aiguillage Stratégique",
            routes: [
                { rule: "context['3_sentiment_analysis'].is_urgent === true", output: "99_escalation" },
                { rule: "context['3_sentiment_analysis'].intent === 'rdv'", output: "10_booking" },
                { rule: "true", output: "5_cultural_response" }
            ]
        },
        {
            id: "5_cultural_response",
            type: "ai.generate",
            name: "🇧🇪 Réponse Belge",
            prompt: "Agis comme un assistant PME belge. \nInfo Mémoire: {{2_memory_recall}}\nMessage Client: {{content}}\nInstruction: Réponds poliment. Si le client est en Wallonie, utilise des termes locaux si approprié. Sois serviable."
        },
        {
            id: "99_escalation",
            type: "system.action",
            name: "🚨 ALERTE MANAGER",
            action: "send_sms_alert",
            payload: "Client mécontent détecté !"
        }
    ]
};

// ==========================================
// ENGINE
// ==========================================
async function runWorkflow(inputData) {
    let context = { 
        input: inputData, 
        content: inputData.message || inputData.transcript || "Message vide",
        trace_id: uuidv4(),
        logs: [] 
    };

    console.log(`🚀 Démarrage Workflow [${context.trace_id}]`);

    const nodes = WORKFLOW_DEFINITION.nodes;
    let currentNodeIndex = 0;

    while (currentNodeIndex < nodes.length) {
        const node = nodes[currentNodeIndex];
        console.log(`⚙️ Node: ${node.id} (${node.type})`);

        try {
            let result = null;

            switch (node.type) {
                case 'code.function':
                    result = new Function('input', 'context', node.code)(context.input, context);
                    break;

                case 'ai.memory_recall':
                    result = await searchMemory(context.content);
                    break;

                case 'ai.analyze':
                case 'ai.generate':
                    const filledPrompt = fillPrompt(node.prompt, context);
                    result = await callGemini(filledPrompt, node.type === 'ai.analyze');
                    break;

                case 'logic.router':
                    const nextNodeId = executeRouter(context, node.routes);
                    if (nextNodeId) {
                        const nextIndex = nodes.findIndex(n => n.id === nextNodeId);
                        if (nextIndex !== -1) {
                            currentNodeIndex = nextIndex;
                            continue;
                        }
                    }
                    break;

                case 'system.action':
                    console.log(`🚨 Action déclenchée: ${node.action}`);
                    result = { status: "executed", action: node.action };
                    break;
            }

            context[node.id] = result;
            context.logs.push({ node: node.id, status: 'success', output: result });
            currentNodeIndex++;

        } catch (error) {
            console.error(`❌ Node Error ${node.id}:`, error.message);
            break;
        }
    }

    await saveToMemory(context.content, context);
    return context;
}

// ==========================================
// UTILITAIRES
// ==========================================
function fillPrompt(template, context) {
    if (!template) return "";
    return template.replace(/\{\{(.*?)\}\}/g, (match, path) => {
        const keys = path.split('.');
        let value = context;
        for (let key of keys) value = value ? value[key] : undefined;
        return typeof value === 'object' ? JSON.stringify(value) : (value || "");
    });
}

function executeRouter(context, routes) {
    for (const route of routes) {
        try {
            if (new Function('context', `return ${route.rule}`)(context)) return route.output;
        } catch (e) { console.error("Route Error", e); }
    }
    return null;
}

async function callGemini(prompt, isJson) {
    if (!genAI) return isJson ? { sentiment: 0 } : "IA non configurée.";
    try {
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash",  // ✅ Dernière version stable
            generationConfig: { responseMimeType: isJson ? "application/json" : "text/plain" }
        });
        const result = await model.generateContent(prompt);
        if (isJson) return JSON.parse(result.response.text());
        return result.response.text();
    } catch (e) {
        console.error("❌ GoogleGenerativeAI Error:", e);
        return isJson ? { sentiment: 0.5 } : "ERREUR CRITIQUE: " + e.message;
    }
}

async function searchMemory(text) {
    if (!sb || !genAI) return "Mémoire désactivée.";
    try {
        const model = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const embResult = await model.embedContent(text);
        const { data } = await sb.rpc('match_documents', {
            query_embedding: embResult.embedding.values,
            match_threshold: 0.5,
            match_count: 3
        });
        if (!data || !data.length) return "Aucun historique.";
        return data.map(d => d.content).join(" | ");
    } catch (e) { return "Erreur accès mémoire."; }
}

async function saveToMemory(text, context) {
    if (!sb || !genAI) return;
    try {
        const model = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const embResult = await model.embedContent(text);
        await sb.from('documents').insert({
            content: text,
            metadata: { trace_id: context.trace_id },
            embedding: embResult.embedding.values
        });
    } catch (e) { console.error("❌ Save Memory Error"); }
}

// ==========================================
// SERVEUR
// ==========================================
app.get('/', (req, res) => {
    res.send('🇧🇪 AI Belgium Backend is Running! Envoyer POST sur /webhook');
});

app.post('/webhook', async (req, res) => {
    const input = req.body;
    if (!input.message && !input.transcript) return res.status(400).json({ error: "Message manquant" });

    const resultContext = await runWorkflow(input);

    const finalResponse = resultContext['5_cultural_response'] || 
                          (resultContext['99_escalation'] ? "Un manager va vous rappeler." : "Reçu.");

    res.json({ success: true, response: finalResponse });
});

app.listen(PORT, () => {
    console.log(`Serveur actif sur le port ${PORT}`);
});

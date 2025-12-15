// ==========================================
// MOTEUR SAAS AI BELGIUM - VERSION FINALE (CORRIGÉE)
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

// --- LE WORKFLOW ---
const WORKFLOW_DEFINITION = {
    name: "AI_System_BE_V8_Platinum",
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
            // On précise bien dans le prompt de ne pas mettre de Markdown
            prompt: "Analyse ce message: '{{content}}'. Retourne UNIQUEMENT un JSON brut (sans balises markdown) sous ce format: { \"sentiment\": score(-1 à 1), \"is_urgent\": boolean, \"intent\": string }."
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
// LE MOTEUR D'EXÉCUTION (ENGINE)
// ==========================================

async function runWorkflow(inputData) {
    let context = { 
        input: inputData, 
        content: inputData.message || inputData.transcript || "Message vide",
        trace_id: uuidv4(),
        logs: [] 
    };

    console.log(`🚀 Démarrage Workflow [${context.trace_id}]`);

    let currentNodeIndex = 0;
    const nodes = WORKFLOW_DEFINITION.nodes;

    while (currentNodeIndex < nodes.length) {
        const node = nodes[currentNodeIndex];
        console.log(`⚙️ Exécution Node: ${node.id} (${node.type})`);
        
        try {
            let result = null;

            switch (node.type) {
                case 'code.function':
                    const func = new Function('input', 'context', node.code);
                    result = func(context.input, context);
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
                    result = { status: "executed", action: node.action };
                    break;
            }

            context[node.id] = result;
            context.logs.push({ node: node.id, status: 'success', output: result });
            currentNodeIndex++;

        } catch (error) {
            console.error(`❌ Erreur noeud ${node.id}:`, error.message);
            break;
        }
    }

    await saveToMemory(context.content, context);
    return context;
}

// ==========================================
// FONCTIONS UTILITAIRES
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
            const evaluator = new Function('context', `return ${route.rule}`);
            if (evaluator(context)) return route.output;
        } catch (e) { console.error("Erreur routeur", e); }
    }
    return null;
}

// --- FONCTION CORRIGÉE SIMPLIFIÉE ---
async function callGemini(prompt, isJson) {
    if (!genAI) return isJson ? { sentiment: 0 } : "IA non configurée (Clé manquante).";
    try {
        // CORRECTION ICI : On a enlevé 'generationConfig' qui faisait planter
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash"
        });
        
        const result = await model.generateContent(prompt);
        let textResponse = result.response.text();

        // Nettoyage manuel du JSON si l'IA ajoute des ```json ... ```
        if (isJson) {
            textResponse = textResponse.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(textResponse);
        }
        
        return textResponse;

    } catch (e) {
        console.error("ERREUR GOOGLE :", e);
        // On laisse l'affichage de l'erreur au cas où, mais ça ne devrait plus planter
        return isJson ? { sentiment: 0.5 } : "ERREUR : " + e.message;
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
            match_count: 2
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
    } catch (e) { console.error("Erreur save mémoire"); }
}

// ==========================================
// SERVEUR
// ==========================================
app.get('/', (req, res) => {
    res.send('🇧🇪 AI Belgium Backend is Running! Envoyer POST sur /webhook');
});

app.post('/webhook', async (req, res) => {
    const input = req.body;
    if (!input.message && !input.transcript) {
        return res.status(400).json({ error: "Message manquant" });
    }
    const resultContext = await runWorkflow(input);
    const finalResponse = resultContext['5_cultural_response'] || 
                          (resultContext['99_escalation'] ? "Un manager va vous rappeler." : "Reçu.");
    
    res.json({ success: true, response: finalResponse });
});

app.listen(PORT, () => {
    console.log(`Serveur actif sur le port ${PORT}`);
});

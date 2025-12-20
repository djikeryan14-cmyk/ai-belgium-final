// =================================================
// DIAGNOSTIC DE CONNEXION GOOGLE (TEST RADICAL)
// =================================================
const express = require('express');
const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Serveur de Diagnostic Actif.'));

app.post('/test', async (req, res) => {
    console.log("🔵 Tentative de connexion à Google...");
    
    try {
        if (!process.env.GEMINI_API_KEY) throw new Error("Clé API manquante !");

        // On teste le modèle standard. S'il échoue, tout échoue.
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const result = await model.generateContent("Réponds juste par le mot: SUCCÈS");
        const reponse = result.response.text();

        console.log("🟢 Réponse reçue :", reponse);
        res.json({ etat: "FONCTIONNEL", message_ia: reponse });

    } catch (error) {
        console.error("🔴 ECHEC CRITIQUE :", error);
        res.status(500).json({ 
            etat: "ECHEC", 
            erreur: error.message, 
            details: "Si tu vois ça, Render est bloqué par Google." 
        });
    }
});

app.listen(PORT, () => console.log(`Serveur prêt sur le port ${PORT}`));

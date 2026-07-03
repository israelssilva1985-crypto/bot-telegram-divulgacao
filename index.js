import express from 'express';
import dotenv from 'dotenv';
import { bots, configurarBot } from './bot.js'; 
import { handleWebhook } from './mercadopago.js';

dotenv.config();

const app = express();
app.use(express.json());

// 🔥 NOVA ROTA: Responde ao Cron-job e ao navegador para evitar o erro "Cannot GET /"
app.get('/', (req, res) => {
    res.status(200).send('🚀 Sistema de Bots de Divulgação está online e operante!');
});

// Rota para receber os avisos de PIX pago do Mercado Pago
app.post('/webhook', handleWebhook);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor Webhook rodando na porta ${PORT}`);
    
    // 🔥 Função inteligente para ligar o bot com "teimosia" (Retry) contra o Render
    const ligarBotComTeimosia = (botInstancia, index, tentativa = 1) => {
        // Injeta os comandos no bot
        configurarBot(botInstancia); 

        botInstancia.telegram.deleteWebhook({ drop_pending_updates: true })
            .then(() => botInstancia.launch())
            .then(() => {
                const botName = botInstancia.botInfo ? botInstancia.botInfo.username : `Bot ${index + 1}`;
                console.log(`✅ 🤖 [${botName}] Online e ouvindo!`);
            })
            .catch((erro) => {
                console.log(`❌ [Tentativa ${tentativa}] Erro ao conectar o Bot ${index + 1}:`, erro.message);
                
                // Se der erro 409, espera 10 segundos para a máquina velha morrer e tenta de novo!
                if (erro.message.includes('409') && tentativa <= 3) {
                    console.log(`⏳ Aguardando a máquina antiga do Render desligar... Tentando conectar novamente em 10 segundos...`);
                    setTimeout(() => ligarBotComTeimosia(botInstancia, index, tentativa + 1), 10000);
                }
            });
    };

    // Inicia o processo para cada bot da lista
    bots.forEach((botInstancia, index) => {
        ligarBotComTeimosia(botInstancia, index);
    });
});

// Segurança para desligar TODOS os bots corretamente
process.once('SIGINT', () => {
    console.log('🛑 Desligando a rede de bots (SIGINT)...');
    bots.forEach(botInstancia => botInstancia.stop('SIGINT'));
});
process.once('SIGTERM', () => {
    console.log('🛑 Desligando a rede de bots (SIGTERM)...');
    bots.forEach(botInstancia => botInstancia.stop('SIGTERM'));
});

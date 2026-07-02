import express from 'express';
import dotenv from 'dotenv';
// 🔥 MUDANÇA AQUI: Agora importamos o array 'bots' que criaremos no bot.js
import { bots } from './bot.js'; 
import { handleWebhook } from './mercadopago.js';

dotenv.config();

const app = express();
app.use(express.json());

// Rota para receber os avisos de PIX pago do Mercado Pago
app.post('/webhook', handleWebhook);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor Webhook rodando na porta ${PORT}`);
    
    // 🔥 Liga a nossa "Fábrica" de Bots do Telegram
    bots.forEach((botInstancia, index) => {
        botInstancia.launch().then(() => {
            // Se o botInfo ainda não estiver carregado, mostra pelo menos o número dele
            const botName = botInstancia.botInfo ? botInstancia.botInfo.username : `Bot ${index + 1}`;
            console.log(`🤖 [${botName}] Online e ouvindo!`);
        }).catch((erro) => {
            console.log(`❌ Erro ao conectar o Bot ${index + 1}:`, erro.message);
        });
    });
});

// Segurança para desligar TODOS os bots corretamente se você fechar o terminal
process.once('SIGINT', () => {
    console.log('🛑 Desligando a rede de bots (SIGINT)...');
    bots.forEach(botInstancia => botInstancia.stop('SIGINT'));
});
process.once('SIGTERM', () => {
    console.log('🛑 Desligando a rede de bots (SIGTERM)...');
    bots.forEach(botInstancia => botInstancia.stop('SIGTERM'));
});

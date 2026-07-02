import express from 'express';
import dotenv from 'dotenv';
// 🔥 CORREÇÃO: Adicionamos a importação do 'configurarBot'
import { bots, configurarBot } from './bot.js'; 
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
        
        // 🔥 CORREÇÃO: Injeta todos os comandos e lógicas no bot ANTES de ligar!
        configurarBot(botInstancia); 

        // 1. Força o Telegram a deletar qualquer Webhook fantasma e limpa mensagens velhas
        botInstancia.telegram.deleteWebhook({ drop_pending_updates: true })
            .then(() => {
                // 2. Agora liga o bot de forma limpa (Polling)
                return botInstancia.launch();
            })
            .then(() => {
                // 3. Sucesso! Mostra o nome do bot.
                const botName = botInstancia.botInfo ? botInstancia.botInfo.username : `Bot ${index + 1}`;
                console.log(`🤖 [${botName}] Online e ouvindo!`);
            })
            .catch((erro) => {
                console.log(`❌ Erro ao conectar o Bot ${index + 1}:`, erro.message);
            });
    });
});

// Segurança para desligar TODOS os bots corretamente se o Render reiniciar
process.once('SIGINT', () => {
    console.log('🛑 Desligando a rede de bots (SIGINT)...');
    bots.forEach(botInstancia => botInstancia.stop('SIGINT'));
});
process.once('SIGTERM', () => {
    console.log('🛑 Desligando a rede de bots (SIGTERM)...');
    bots.forEach(botInstancia => botInstancia.stop('SIGTERM'));
});

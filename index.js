import express from 'express';
import dotenv from 'dotenv';
import { bot } from './bot.js';
import { handleWebhook } from './mercadopago.js';

dotenv.config();

const app = express();
app.use(express.json());

// Rota para receber os avisos de PIX pago do Mercado Pago
app.post('/webhook', handleWebhook);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor Webhook rodando na porta ${PORT}`);
    
    // Liga o Bot do Telegram
    bot.launch().then(() => {
        console.log('🤖 Bot do Telegram Online e ouvindo!');
    }).catch((erro) => {
        console.log('❌ Erro ao conectar no Telegram:', erro.message);
    });
});

// Segurança para desligar o bot corretamente se você fechar o terminal
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
import { MercadoPagoConfig, Payment } from 'mercadopago';
import { supabase } from './db.js';
import { BOOST_PLANS } from './config.js';
import dotenv from 'dotenv';
dotenv.config();

const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const paymentClient = new Payment(client);

export async function createPixPayment(userId, groupId, planType) {
    const plan = BOOST_PLANS[planType];
    const paymentData = {
        transaction_amount: plan.price,
        description: `Impulso ${plan.name}`,
        payment_method_id: 'pix',
        payer: { email: `user${userId}@telegrambot.com` },
        metadata: { group_id: groupId, user_id: userId, plan: planType }
    };

    const response = await paymentClient.create({ body: paymentData });

    await supabase.from('payments').insert({
        group_id: groupId, user_id: userId, mp_payment_id: response.id,
        amount: plan.price, tier_purchased: planType
    });

   return { 
        qrCodeBase64: response.point_of_interaction.transaction_data.qr_code_base64,
        pixCopiaECola: response.point_of_interaction.transaction_data.qr_code
    };
}

export async function handleWebhook(req, res) {
    const { action, data } = req.body;
    if (action === 'payment.created' || action === 'payment.updated') {
        const paymentInfo = await paymentClient.get({ id: data.id });
        
        if (paymentInfo.status === 'approved') {
            const { group_id, plan } = paymentInfo.metadata;
            const hoursToAdd = BOOST_PLANS[plan].hours;
            
            await supabase.from('payments').update({ status: 'approved' }).eq('mp_payment_id', data.id);
            
            const expiresAt = new Date(Date.now() + hoursToAdd * 60 * 60 * 1000).toISOString();
            await supabase.from('groups').update({ 
                boost_tier: plan, boost_expires_at: expiresAt 
            }).eq('id', group_id);
            console.log(`✅ Pagamento aprovado! Impulso ${plan} ativado para o grupo ${group_id}`);
        }
    }
    res.status(200).send('OK');
}
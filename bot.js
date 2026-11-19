import { Telegraf } from 'telegraf';
import cron from 'node-cron';
import { supabase } from './db.js';
import dotenv from 'dotenv';
import express from 'express';
import { createPixPayment, handleWebhook } from './mercadopago.js';

dotenv.config();

const tokens = [
    process.env.BOT_TOKEN_1, 
    process.env.BOT_TOKEN_2, 
    process.env.BOT_TOKEN_3
].filter(Boolean);

export const bots = tokens.map(token => new Telegraf(token));

// ==========================================
// 🛡️ TRATADOR DE ERROS GLOBAL COM LIMPEZA AUTOMÁTICA
// ==========================================
bots.forEach((botInstancia, index) => {
    botInstancia.catch(async (err, ctx) => {
        const botName = ctx.botInfo ? ctx.botInfo.username : `Bot ${index + 1}`;
        const erroMsg = err.response ? err.response.description : err.message;
        
        // Verifica erros de banimento, expulsão ou grupo inexistente
        if (erroMsg && (erroMsg.includes("bot was blocked") || erroMsg.includes("kicked") || erroMsg.includes("chat not found") || erroMsg.includes("not a member"))) {
            console.log(`⚠️ [AVISO] O ${botName} foi bloqueado/removido. Limpando do banco de dados...`);
            
            // Tenta capturar o ID do grupo que gerou o erro
            const chatId = err.on && err.on.payload ? err.on.payload.chat_id : null;
            
            if (chatId) {
                const { error } = await supabase.from('groups').delete().eq('telegram_chat_id', chatId);
                
                if (error) {
                    console.error(`❌ Erro ao deletar o chat ${chatId} do banco:`, error.message);
                } else {
                    console.log(`🧹 Faxina feita! ID fantasma ${chatId} removido com sucesso!`);
                }
            }
        } else {
            console.log(`❌ [ERRO GLOBAL] Falha no ${botName}:`, erroMsg);
        }
    });
});

// Memória para saber quem está a tentar renomear um grupo
const renomeando = new Map();

// ==========================================
// ⏳ FUNÇÃO DE PAUSA (DELAY) PARA EVITAR SPAM
// ==========================================
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ==========================================
// 📦 BUSCA PAGINADA (PUXA TODOS OS GRUPOS SEM LIMITE DE 1.000)
// ==========================================
async function buscarTodosOsGrupos(statusList = ['approved', 'removed']) {
    let todos = [];
    let inicio = 0;
    const tamanhoPagina = 1000;

    while (true) {
        const { data, error } = await supabase
            .from('groups')
            .select('*')
            .in('status', statusList)
            .range(inicio, inicio + tamanhoPagina - 1);

        if (error) {
            console.error('❌ [ERRO] Falha ao buscar grupos paginados:', error.message);
            break;
        }

        if (!data || data.length === 0) break;

        todos = todos.concat(data);

        if (data.length < tamanhoPagina) break;
        inicio += tamanhoPagina;
    }

    return todos;
}

// ==========================================
// 🎲 SORTEIO JUSTO (FISHER-YATES)
// ==========================================
function sortearItens(lista, quantidade) {
    const copia = [...lista];
    for (let i = copia.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copia[i], copia[j]] = [copia[j], copia[i]];
    }
    return copia.slice(0, quantidade);
}

// ==========================================
// 🧹 VARREDOR DE IMPULSOS EXPIRADOS (A cada hora)
// ==========================================
async function limparImpulsosExpirados() {
    console.log('🧹 [SISTEMA] Iniciando varredura de impulsos expirados...');
    const agora = new Date().toISOString(); 

    try {
        const { data, error } = await supabase
            .from('groups')
            .update({ boost_tier: 'none', boost_expires_at: null })
            .lt('boost_expires_at', agora)
            .neq('boost_tier', 'none')
            .select();

        if (error) {
            console.error('❌ [ERRO] Falha ao limpar impulsos no banco:', error.message);
            return;
        }

        if (data && data.length > 0) {
            console.log(`✅ [SUCESSO] Limpeza concluída! ${data.length} grupos perderam o VIP (tempo esgotado).`);
        } else {
            console.log('✅ [INFO] Tudo limpo. Nenhum impulso expirado no momento.');
        }
    } catch (err) {
        console.error('❌ [ERRO] Falha inesperada na varredura:', err);
    }
}

limparImpulsosExpirados();
cron.schedule('0 * * * *', limparImpulsosExpirados);

// ==========================================
// 🗑️ FAXINA DIÁRIA: REMOVER GRUPOS PAUSADOS (OTIMIZADO EM LOTE)
// ==========================================
cron.schedule('0 0 * * *', async () => {
    console.log('🗑️ [SISTEMA] Iniciando faxina diária: Buscando grupos abandonados (removed/rejected)...');
    
    try {
        const { data: gruposParaDeletar, error: fetchError } = await supabase
            .from('groups')
            .select('id')
            .in('status', ['removed', 'rejected']) 
            .eq('boost_tier', 'none'); 

        if (fetchError || !gruposParaDeletar || gruposParaDeletar.length === 0) {
            console.log('✅ [INFO] Faxina concluída! Nenhum grupo apto para exclusão.');
            return;
        }

        const idsParaDeletar = gruposParaDeletar.map(g => g.id);
        
        await supabase.from('boost_history').delete().in('group_id', idsParaDeletar);
        await supabase.from('payments').delete().in('group_id', idsParaDeletar);
        
        const { error: deleteError } = await supabase.from('groups').delete().in('id', idsParaDeletar);

        if (!deleteError) {
            console.log(`✅ [SUCESSO] Faxina concluída! ${idsParaDeletar.length} grupos deletados com sucesso do banco.`);
        } else {
            console.error('❌ [ERRO] Falha no delete em lote:', deleteError.message);
        }

    } catch (err) {
        console.error('❌ [ERRO] Erro inesperado na faxina diária:', err);
    }
});

// ==========================================
// 👥 ATUALIZADOR DE MEMBROS E LINKS (A cada 6h)
// ==========================================
async function atualizarContagemMembros() {
    console.log('👥 [SISTEMA] Iniciando atualização da contagem de membros e links dos grupos...');

    try {
        const grupos = await buscarTodosOsGrupos(['approved', 'removed']);

        if (!grupos || grupos.length === 0) {
            console.error('❌ [ERRO] Falha ao buscar grupos para atualizar.');
            return;
        }

        let atualizados = 0;

        for (const grupo of grupos) {
            try {
                let infoAtualizada = false;
                for (const botAtual of bots) {
                    try {
                        const chatInfo = await botAtual.telegram.getChat(grupo.telegram_chat_id);
                        const membros = await botAtual.telegram.getChatMembersCount(grupo.telegram_chat_id);
                        
                        let linkAtualizado = '';
                        if (chatInfo.username) {
                            linkAtualizado = `https://t.me/${chatInfo.username}`;
                        } else if (chatInfo.invite_link) {
                            linkAtualizado = chatInfo.invite_link;
                        } else {
                            linkAtualizado = await botAtual.telegram.exportChatInviteLink(grupo.telegram_chat_id);
                        }

                        await supabase.from('groups').update({ 
                            member_count: membros,
                            link: linkAtualizado 
                        }).eq('id', grupo.id);
                        
                        atualizados++;
                        infoAtualizada = true;
                        break;
                    } catch (err) {
                        continue;
                    }
                }
                
                if (!infoAtualizada) {
                    console.log(`⚠️ [AVISO] Sem acesso ao grupo: ${grupo.name}. Alterando status para 'removed'.`);
                    
                    await supabase.from('groups').update({ status: 'removed' }).eq('id', grupo.id);

                    if (grupo.user_id) {
                        try {
                            const aviso = `⚠️ *Atenção!*\n\nNão consegui acessar os dados do seu grupo/canal *${grupo.name}* (provavelmente perdi as permissões de administrador ou o link expirou).\n\nPor conta disso, a divulgação do grupo foi **PAUSADA**.\n\nPara voltar à rotação de divulgação, adicione-me novamente como administrador com as permissões corretas!`;
                            
                            await bots[0].telegram.sendMessage(grupo.user_id, aviso, { parse_mode: 'Markdown' });
                        } catch (msgErr) {
                            console.log(`⚠️ Não foi possível notificar o dono do grupo ${grupo.name} (Pode ter bloqueado o bot).`);
                        }
                    }
                }
            } catch (err) {
                console.error(`❌ [ERRO] Falha no grupo ${grupo.name}:`, err.message);
            }
            await sleep(1500);
        }

        console.log(`✅ [SUCESSO] Atualização concluída! ${atualizados} grupos tiveram links e membros renovados.`);

    } catch (err) {
        console.error('❌ [ERRO] Erro inesperado ao atualizar membros:', err);
    }
}

cron.schedule('0 */6 * * *', atualizarContagemMembros);

// ==========================================
// 1. COMANDO /start
// ==========================================
export function configurarBot(bot) {
bot.start(async (ctx) => {
    if (ctx.chat.type === 'private') {
        try {
            const userId = ctx.from.id.toString();
            const username = ctx.from.username || ctx.from.first_name || 'Sem_Nome';

            const { error } = await supabase.from('users').upsert({ telegram_id: userId, username: username }, { onConflict: 'telegram_id' });

            if (error) {
                console.error("❌ [ERRO] Erro ao salvar usuário no banco:", error.message);
            } else {
                console.log(`✅ [INFO] Usuário ${username} registrado/atualizado no sistema.`);
            }

            const botUsername = ctx.botInfo.username;
            const mensagem = `Olá! 🤖\n\nPara participar da nossa rede de divulgação, adicione este bot ao seu Grupo ou Canal como Administrador.\n\nDepois que aprovarmos no sistema, seu grupo entrará na nossa rotação automática! \n\nNossos bots de divulgaçao. \n\n@divulga_parceiros_OFC_bot \n\n@divulga_grupos_bot \n\n@divulgacao_de_links_bot`;

            await ctx.reply(mensagem, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🟢 Add Canal', url: `https://t.me/${botUsername}?startchannel=true` },
                            { text: '🟢 Add Grupo', url: `https://t.me/${botUsername}?startgroup=true` }
                        ],
                        [{ text: '🗂 Meus Canais e Grupos', callback_data: 'meus_grupos' }]
                    ]
                }
            });
        } catch (err) {
            console.error(`❌ [ERRO /start] Falha ao processar start de ${ctx.from.first_name}:`, err.message);
        }
    }
});

// ==========================================
// 2. BOTÃO: MEUS CANAIS E GRUPOS
// ==========================================
bot.action('meus_grupos', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    
    const userId = ctx.from.id.toString();
    const { data: meusGrupos, error } = await supabase.from('groups').select('*').eq('user_id', userId);
    
    if (error) console.log("❌ [ERRO] Falha ao buscar grupos:", error.message);

    if (!meusGrupos || meusGrupos.length === 0) {
        return ctx.editMessageText('Você ainda não tem grupos ou canais cadastrados no sistema.', {
            reply_markup: { inline_keyboard: [[{ text: '⬅️ Voltar ao Menu', callback_data: 'menu_principal' }]] }
        }).catch(() => {});
    }
    
    const botoesGrupos = meusGrupos.map(g => {
        const statusIcon = g.status === 'approved' ? '✅' : g.status === 'pending' ? '⏳' : g.status === 'removed' ? '⚠️' : '❌';
        return [{ text: `${statusIcon} ${g.name}`, callback_data: `manage_${g.id}` }];
    });
    
    botoesGrupos.push([{ text: '⬅️ Voltar ao Menu', callback_data: 'menu_principal' }]);
    
    await ctx.editMessageText('👉 *Selecione o grupo cujas configurações você deseja alterar:*', { 
        parse_mode: 'Markdown', reply_markup: { inline_keyboard: botoesGrupos }
    }).catch(() => {});
});

// ==========================================
// 3. MENU DE CONFIGURAÇÕES DE UM GRUPO ESPECÍFICO
// ==========================================
bot.action(/^manage_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const groupId = ctx.match[1]; 
    
    const { data: grupoInfo, error } = await supabase.from('groups').select('*').eq('id', groupId).single();
    
    if (error || !grupoInfo) return ctx.reply('❌ Grupo não encontrado no banco de dados.');

    const msg = `⚙️ *Gerenciando:* ${grupoInfo.name}\n\nO que você deseja fazer com este grupo?`;

    await ctx.editMessageText(msg, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🚀 Impulsionar', callback_data: `boost_${grupoInfo.id}` }],
                [{ text: '✏️ Editar Nome do grupo', callback_data: `editname_${grupoInfo.id}` }],
                [{ text: '🗑️ Remover Grupo', callback_data: `remove_${grupoInfo.id}` }],
                [{ text: '⬅️ Voltar à Lista', callback_data: 'meus_grupos' }]
            ]
        }
    }).catch(() => {});
});

// ==========================================
// 4. EDIÇÃO DE NOME
// ==========================================
bot.action(/^editname_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    renomeando.set(ctx.from.id, ctx.match[1]);
    await ctx.reply('✏️ *Qual será o novo nome?*\n\nEscreva a sua resposta abaixo (pode usar emojis):', {
        parse_mode: 'Markdown', reply_markup: { force_reply: true }
    });
});

bot.on('text', async (ctx, next) => {
    const userId = ctx.from.id;
    const texto = ctx.message.text;
    
    if (texto.startsWith('/')) return next();
    
    if (renomeando.has(userId)) {
        const groupId = renomeando.get(userId);
        renomeando.delete(userId);
        
        const { error } = await supabase.from('groups').update({ name: texto }).eq('id', groupId).eq('user_id', userId.toString());
            
        if (error) return ctx.reply('❌ Ocorreu um erro ao guardar o novo nome.');
        
        await ctx.reply(`✅ O nome do grupo foi atualizado com sucesso para:\n*${texto}*\n\nPara ver a lista atualizada, envie /start novamente.`, { parse_mode: 'Markdown' });
        return;
    }
    return next();
});

// ==========================================
// 5. VOLTAR AO MENU PRINCIPAL
// ==========================================
bot.action('menu_principal', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    
    const textoMenu = 'Olá! 🤖\n\nPara participar da nossa rede de divulgação, adicione este bot ao seu Grupo ou Canal como Administrador.\n\nDepois que aprovarmos no sistema, seu grupo entrará na nossa rotação automática!';
    const botUsername = ctx.botInfo.username;

    await ctx.editMessageText(textoMenu, {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🟢 Add Canal', url: `https://t.me/${botUsername}?startchannel=true` }, 
                    { text: '🟢 Add Grupo', url: `https://t.me/${botUsername}?startgroup=true` }
                ],
                [{ text: '🗂 Meus Canais e Grupos', callback_data: 'meus_grupos' }]
            ]
        }
    }).catch(() => {});
});

// ==========================================
// 6. DETECTOR INTELIGENTE DE ENTRADA/SAÍDA
// ==========================================
bot.on('my_chat_member', async (ctx) => {
    const chat = ctx.chat;
    const newStatus = ctx.myChatMember.new_chat_member.status;
    const userId = ctx.from.id.toString();

    if (['kicked', 'left', 'member', 'restricted'].includes(newStatus)) {
        console.log(`🚨 [ALERTA] Bot perdeu permissões/saiu do grupo: ${chat.title}. Alterando status para 'removed'...`);
        
        const { data: grupo } = await supabase
            .from('groups')
            .select('user_id, name')
            .eq('telegram_chat_id', chat.id.toString())
            .single();

        if (grupo) {
            await supabase.from('groups').update({ status: 'removed' }).eq('telegram_chat_id', chat.id.toString());
            
            try {
                const avisoPv = `⚠️ *ALERTA DE SISTEMA*\n\nPerdi as minhas permissões de **Administrador** no grupo/canal *${grupo.name}*!\n\nA divulgação foi **PAUSADA** (Status: SUSPENSO).\n\n♻️ *Como resolver?*\nPromova-me novamente como Administrador para reativar a divulgação automática!`;
                await bot.telegram.sendMessage(grupo.user_id, avisoPv, { parse_mode: 'Markdown' });
            } catch (e) {}

            if (['member', 'restricted'].includes(newStatus)) {
                try {
                    const userMention = `<a href="tg://user?id=${grupo.user_id}">${ctx.from.first_name || 'Admin'}</a>`;
                    await ctx.replyWithHTML(`⚠️ ${userMention}, perdi as permissões de <b>Administrador</b>! A divulgação deste grupo foi <b>PAUSADA</b>.`).catch(() => {});
                } catch (e) {}
            }
        }
        return; 
    }

    if (newStatus === 'administrator') {
        const username = ctx.from.username || ctx.from.first_name || 'Sem_Nome';
        await supabase.from('users').upsert({ telegram_id: userId, username: username }, { onConflict: 'telegram_id' });

        let link = '';
        if (chat.username) {
            link = `https://t.me/${chat.username}`;
        } else {
            try {
                link = await ctx.exportChatInviteLink();
            } catch (err) {
                const msgErro = `⚠️ *Atenção!*\n\nNão consegui ler o link de convite do grupo *${chat.title}*.\nPor favor, conceda a permissão de *"Convidar Usuários via Link"* nas configurações de administrador.`;
                try { await ctx.telegram.sendMessage(userId, msgErro, { parse_mode: 'Markdown' }); } catch (e) {}
                try { await ctx.replyWithHTML(`⚠️ Preciso da permissão de <b>Convidar Usuários via Link</b> para operar!`).catch(() => {}); } catch (e) {}
                return; 
            }
        }

        const { data: existingGroup } = await supabase.from('groups').select('*').eq('telegram_chat_id', chat.id.toString()).single();

        if (existingGroup) {
            if (existingGroup.status === 'removed') {
                await supabase.from('groups').update({ link: link, status: 'approved', user_id: userId }).eq('telegram_chat_id', chat.id.toString());
                
                try { await ctx.telegram.sendMessage(userId, `✅ *PERMISSÕES RESTAURADAS!*\n\nAs minhas permissões no grupo *${chat.title}* foram ativadas.\nStatus alterado para: 🟢 APROVADO.`, { parse_mode: 'Markdown' }); } catch(e){}
                
                try {
                    const userMention = `<a href="tg://user?id=${userId}">${ctx.from.first_name}</a>`;
                    await ctx.replyWithHTML(`🎉 <b>Permissões Restauradas!</b>\n\n${userMention}, o grupo <b>${chat.title}</b> retornou com sucesso para a rotação de divulgação!`).catch(() => {});
                } catch(e){}
            } 
            else if (existingGroup.status === 'pending') {
                try { await ctx.replyWithHTML(`ℹ️ Olá! Este grupo já está <b>aguardando aprovação</b> no nosso sistema. Em breve será avaliado!`).catch(()=>null); } catch(e){}
            }
            else if (existingGroup.status === 'approved') {
                try { await ctx.replyWithHTML(`🎉 <b>Auto-Aprovado!</b>\n\nEste grupo já faz parte da nossa rede de parceiros!`).catch(()=>null); } catch(e){}
            }
        } else {
            const { error } = await supabase.from('groups').insert([{ user_id: userId, telegram_chat_id: chat.id.toString(), name: chat.title, link: link, status: 'pending' }]);

            if (!error) {
                console.log(`✅ [INFO] Grupo ${chat.title} cadastrado e pendente de aprovação.`);
                const userMention = `<a href="tg://user?id=${userId}">${ctx.from.first_name}</a>`;
                
                try {
                    await ctx.telegram.sendMessage(userId, `✅ Sucesso! Detectei que você me adicionou como Admin em:\n*${chat.title}*\n\nStatus: ⏳ Pendente de Aprovação.`, { parse_mode: 'Markdown' });
                } catch (err) {}

                try {
                    const botUsername = ctx.botInfo.username;
                    const avisoGrupo = `✅ <b>Fui ativado com sucesso!</b>\n\n${userMention}, o seu grupo foi cadastrado e está ⏳ <b>Pendente de Aprovação</b>.\n\n👉 Clique em @${botUsername} e aperte em <b>COMEÇAR</b> para ter acesso ao painel do seu grupo!`;
                    await ctx.replyWithHTML(avisoGrupo).catch(() => {});
                } catch (e) {}
            }
        }
    }
});

// ==========================================
// 🔞 BOTÃO FIXO NO TOPO ABSOLUTO (PRIVACY)
// ==========================================
const CONFIG_PRIVACY = {
    url: 'https://privacy.com.br/profile/lanairezende',
    frases: [
        '🔥 CONTEÚDO EXCLUSIVO NO PRIVACY 🔞',
        '🤫 VÍDEOS SEM CENSURA AQUI 👀🔥',
        '💋 ACESSE MEU PRIVACY AGORA 😈',
        '🚨 PRÉVIAS LIBERADAS NO PRIVACY 🔥',
        '🔞 TUDO QUE NÃO POSSO POSTAR AQUI 🤫',
        '💎 ASSINE MEU PRIVACY COM DESCONTO 💸',
        '🔥 NOVIDADES QUENTES NO PRIVACY 🌶️',
        '👀 VEM VER MEUS VÍDEOS EXCLUSIVOS 💋',
        '😈 CONTEÚDO PROIBIDO NO TELEGRAM 🔞',
        '⚡ ACESSO IMEDIATO AO MEU PRIVACY 🔥',
        '📸 FOTOS E VÍDEOS NOVOS HOJE 💦',
        '🎁 PROMOÇÃO RELÂMPAGO NO PRIVACY 🚨',
        '🌶️ O MELHOR CONTEÚDO ESTÁ AQUI 👇🔥',
        '🔒 MEU CANAL VIP NO PRIVACY 💋',
        '💥 NÃO CLIQUE SE FOR CURIOSO(A) 👀🔞'
    ]
};

// ==========================================
// 🔗 SEUS 14 LINKS PERSONALIZADOS (LOGO ABAIXO DO PRIVACY)
// ==========================================
const MEUS_LINKS_PERSONALIZADOS = [
    { titulo: 'BRECHA LIBERADA HOJE 🚨🎰', url: 'https://98a5.xyz/?pid=1425253988' },
    { titulo: 'SAQUE PIX INSTANTÂNEO ⚡💸', url: 'http://wdbz8e.com/?pid=3946842948' },
    { titulo: 'CADASTROU, GANHOU NO PIX 🎁😱', url: 'https://838x1.com/?pid=4138194760' },
    { titulo: 'NOVA PLATAFORMA SECRETA 🤫🔥', url: 'https://76p11.com/?a=9pwvvbwm' },
    { titulo: 'NOVO BUG DO TIGRE 🐯💥', url: 'https://30win104.com/?id=846395032' },
    { titulo: 'DEPÓSITO DE APENAS 5 REAIS 🪙🚀', url: 'https://G45004.com/?pid=4258938277' },
    { titulo: 'GRINGA PAGANDO MAIS QUE AS CHINESAS 📈👀', url: 'https://9bm.cloud/?pid=1411406752' },
    { titulo: 'TESTE ANTES QUE CORRIJAM ⏳🚨', url: 'https://234vip37.com/?pid=645762014' },
    { titulo: 'CHINESA SEM LIMITES DE SAQUE 🇨🇳💰', url: 'https://ydrgl3.com/?pid=3468467757' },
    { titulo: 'BÔNUS DE BOAS-VINDAS SEM DEPÓSITO 🎟️🤑', url: 'https://rt9p87.com/?pid=2540232740' },
    { titulo: 'MULTIPLICADOR MÁXIMO ATIVADO 💣🔥', url: 'https://75cc12.com/?pid=3881404916' },
    { titulo: 'PLATAFORMA DO DRAGÃO SOLTANDO 🐉💸', url: 'https://5kkk07.com/?pid=6600386280' },
    { titulo: 'RODADAS GRÁTIS LIBERADAS 🎰🎁', url: 'https://79p003.com/?pid=6366853274' },
    { titulo: 'BANCA BAIXA MULTIPLICANDO RÁPIDO 📊💵', url: 'https://ff345.org/?pid=1438668279' }
];

// ==========================================
// 7. MOTOR DE DIVULGAÇÃO (100% SEGURO - APENAS LEITURA)
// ==========================================

const emExecucao = { 0: false, 1: false, 2: false };

async function rodarDivulgacao(botAtual, botIndex) {
    if (emExecucao[botIndex]) {
        console.log(`⚠️ [AVISO] Bot ${botIndex + 1} já está em execução. Ignorando chamada duplicada.`);
        return;
    }
    emExecucao[botIndex] = true;

    try {
        console.log(`🔄 [SISTEMA] Iniciando rotina de postagem para o Bot ${botIndex + 1}...`);
        
        // Busca TODOS os grupos do banco sem o corte de 1.000 linhas
        const todosGrupos = await buscarTodosOsGrupos(['approved', 'removed']);

        if (!todosGrupos || todosGrupos.length === 0) {
            console.log(`⚠️ [INFO] Bot ${botIndex + 1}: Nenhum grupo encontrado.`);
            emExecucao[botIndex] = false;
            return;
        }

        // Separa apenas os aprovados para montagem dos botões
        const gruposParaDivulgar = todosGrupos.filter(g => g.status === 'approved');

        // Prioriza boost_tier ativo antes de verificar plan
        const getPeso = (grupo) => {
            const boost = (grupo.boost_tier || '').toLowerCase();
            const plan = (grupo.plan || '').toLowerCase();
            const planoAtivo = (boost && boost !== 'none') ? boost : plan;

            if (['diamante', 'diamond'].includes(planoAtivo)) return 4;
            if (['ouro', 'gold', 'vip', 'premium'].includes(planoAtivo)) return 3;
            if (['prata', 'silver'].includes(planoAtivo)) return 2;
            if (['bronze'].includes(planoAtivo)) return 1;
            return 0; 
        };

        // Mantido limpo sem restaurar os emojis
        const getEmoji = (peso) => ['‍', '‍', '‍', '‍', '‍'][peso] || '‍';

        const alvosOrdenados = gruposParaDivulgar
            .map(g => ({ ...g, membros: g.member_count || 0 }))
            .sort((a, b) => b.membros - a.membros);

        const vipLinks = alvosOrdenados.filter(g => getPeso(g) > 0);
        const freeLinks = alvosOrdenados.filter(g => getPeso(g) === 0);

        console.log(`📊 [BOT ${botIndex + 1}] Total no banco: ${todosGrupos.length} | Aprovados: ${gruposParaDivulgar.length} | VIPs ativos: ${vipLinks.length}`);

        freeLinks.sort(() => Math.random() - 0.5);

        // Prioriza enviar primeiro nos grupos VIP para garantir entrega imediata
        const filaDeEnvio = [...todosGrupos].sort((a, b) => getPeso(b) - getPeso(a));

        const botUsername = botAtual.botInfo ? botAtual.botInfo.username : 'divulga_parceiros_OFC_bot';
        const textoMensagem = `💯 <b>Grupos do Telegram</b>\n\n✅ Entre em nosso site e aumente seu alcance: https://grupolink.site/\n\n🔥 <b>Adicione nossos bots no seu canal ou grupo:</b>\n🤖 @divulga_parceiros_OFC_bot\n🤖 @divulga_grupos_bot\n🤖 @divulgacao_de_links_bot`;
        
        let enviosComSucesso = 0;
        let fIndex = 0;
        let privacyIndex = Math.floor(Math.random() * CONFIG_PRIVACY.frases.length);
        const TOTAL_GRUPOS_POR_LISTA = 20; 
        const MAX_VIPS_POR_LISTA = 10;

        for (let i = 0; i < filaDeEnvio.length; i++) {
            const target = filaDeEnvio[i];

            // Sorteia 10 grupos aleatórios dentre TODOS os VIPs ativos a cada mensagem disparada
            let blocoVips = [];
            if (vipLinks.length > 0) {
                const qtdVipsNaLista = Math.min(MAX_VIPS_POR_LISTA, vipLinks.length);
                blocoVips = sortearItens(vipLinks, qtdVipsNaLista)
                    .sort((a, b) => getPeso(b) - getPeso(a));
            }

            let blocoFree = [];
            let vagasFree = TOTAL_GRUPOS_POR_LISTA - blocoVips.length;
            if (freeLinks.length > 0 && vagasFree > 0) {
                for (let j = 0; j < vagasFree; j++) {
                    blocoFree.push(freeLinks[fIndex % freeLinks.length]);
                    fIndex++;
                }
            }

            let blocoAtual = [...blocoVips, ...blocoFree];
            const linksEmbaralhados = [...MEUS_LINKS_PERSONALIZADOS].sort(() => 0.5 - Math.random());
            
            const frasePrivacyAtual = CONFIG_PRIVACY.frases[privacyIndex % CONFIG_PRIVACY.frases.length];
            privacyIndex++;

            const botaoPrivacyTopo = [
                { text: frasePrivacyAtual, url: CONFIG_PRIVACY.url }
            ];

            const topoPersonalizado = [
                [{ text: linksEmbaralhados[0].titulo, url: linksEmbaralhados[0].url }],
                [{ text: linksEmbaralhados[1].titulo, url: linksEmbaralhados[1].url }]
            ];

            const rodapePersonalizado = [
                [{ text: linksEmbaralhados[2].titulo, url: linksEmbaralhados[2].url }],
                [{ text: linksEmbaralhados[3].titulo, url: linksEmbaralhados[3].url }]
            ];

            let botoesGrupos = blocoAtual.map(grupo => {
                const urlSegura = (grupo.link && grupo.link.startsWith('http')) ? grupo.link : 'https://grupolink.site/';
                return [{ text: `${getEmoji(getPeso(grupo))}${grupo.name}`, url: urlSegura }];
            });
            
            let tecladoBotoes = [
                botaoPrivacyTopo,
                ...topoPersonalizado,
                ...botoesGrupos,
                ...rodapePersonalizado
            ];

            tecladoBotoes.push([
                { text: '✅ Adicionar', url: `https://t.me/${botUsername}?startgroup=true` },
                { text: '🌐 Lista Completa', url: 'https://grupolink.site/grupos-do-bot' }
            ]);

            try {
                const mensagemEnviada = await botAtual.telegram.sendMessage(target.telegram_chat_id, textoMensagem, { 
                    parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: tecladoBotoes }
                });
                await botAtual.telegram.pinChatMessage(target.telegram_chat_id, mensagemEnviada.message_id, { disable_notification: true }).catch(() => {});
                enviosComSucesso++;
            } catch (err) {
                const erroMsg = err.response ? err.response.description : err.message;
                console.log(`⚠️ [AVISO DE ENVIO] Falha no grupo ${target.name} (ID: ${target.telegram_chat_id}): ${erroMsg}`);
            }
            
            await new Promise(resolve => setTimeout(resolve, 3000));
        }

        console.log(`✅ [SUCESSO] Divulgação Bot ${botIndex + 1} concluída! ${enviosComSucesso} envios realizados.`);
    
    } catch (error) {
        console.log(`❌ [ERRO] Falha geral no Bot ${botIndex + 1}:`, error);
    } finally {
        emExecucao[botIndex] = false;
    }
}

// ==========================================
// AGENDAMENTO CRON (INTERCALADO)
// ==========================================
const cronsDeHorario = [
    '0 0,4,8,12,16,20 * * *', // Bot 1 (00:00, 04:00, 08:00...)
    '0 1,5,9,13,17,21 * * *', // Bot 2 (01:00, 05:00, 09:00...)
    '0 2,6,10,14,18,22 * * *'  // Bot 3 (02:00, 06:00, 10:00...)
];

if (!global.cronsRegistrados) {
    bots.forEach((botInstancia, index) => {
        if (cronsDeHorario[index]) {
            cron.schedule(cronsDeHorario[index], () => {
                rodarDivulgacao(botInstancia, index);
            }, {
                scheduled: true,
                timezone: "America/Sao_Paulo"
            });
        }
    });
    global.cronsRegistrados = true;
    console.log("⏰ [SISTEMA] Cronjobs registrados com sucesso no fuso horário do Brasil!");
}
    
// ==========================================
// 8. DETECTOR DE APROVAÇÃO/REJEIÇÃO (REALTIME)
// ==========================================
supabase.channel('mudancas-de-status')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'groups' }, async (payload) => {
        const { status: statusAntigo } = payload.old;
        const { status: statusNovo, user_id: userId, name: nomeGrupo } = payload.new;

        if (statusAntigo !== statusNovo) {
            for (const botAtual of bots) {
                try {
                    if (statusNovo === 'approved') {
                        await botAtual.telegram.sendMessage(userId, `🎉 *Boas notícias!*\n\nSeu grupo/canal *${nomeGrupo}* foi **APROVADO**! Ele já está na nossa rotação.`, { parse_mode: 'Markdown' });
                    } else if (statusNovo === 'rejected') {
                        await botAtual.telegram.sendMessage(userId, `❌ *Aviso!*\n\nSeu grupo/canal *${nomeGrupo}* foi **REJEITADO** no nosso sistema.`, { parse_mode: 'Markdown' });
                    }
                    break;
                } catch (err) {
                    continue;
                }
            }
        }
    }).subscribe();

bot.on('new_chat_members', async (ctx) => {
    try {
        if (ctx.message.new_chat_members.some(m => m.id === ctx.botInfo.id)) {
            await ctx.replyWithHTML("🚀 <b>Olá!</b>\n\nPreciso que me promova a <b>Administrador</b> com permissão de <b>Fixar Mensagens e Convidar Usuários</b> para funcionar!").catch(() => {});
            
            const linkInicial = ctx.chat.username ? `https://t.me/${ctx.chat.username}` : 'AGUARDANDO_ADMIN';

            const { error } = await supabase.from('groups').upsert({
                telegram_chat_id: ctx.chat.id.toString(), 
                name: ctx.chat.title, 
                link: linkInicial, 
                status: 'pending',
                user_id: ctx.from.id.toString()
            });
            
            if (!error) {
                try {
                    await ctx.telegram.sendMessage(
                        ctx.from.id, 
                        `✅ O grupo <b>${ctx.chat.title}</b> foi registrado e enviado para aprovação no site!`, 
                        { parse_mode: 'HTML' }
                    );
                } catch (erro) {
                    await ctx.replyWithHTML(`✅ <a href="tg://user?id=${ctx.from.id}">${ctx.from.first_name}</a>, o grupo <b>${ctx.chat.title}</b> foi registrado e enviado para aprovação no site!`).catch(() => null);
                }
            }
        }
    } catch (e) { console.error("❌ [ERRO] Falha geral ao detetar novo membro:", e); }
});

// ==========================================
// 9. REMOVER GRUPO
// ==========================================
bot.action(/^remove_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const groupId = ctx.match[1];
    const userId = ctx.from.id.toString();

    const { data: grupoInfo, error: findError } = await supabase.from('groups').select('*').eq('id', groupId).eq('user_id', userId).single();

    if (!grupoInfo || findError) return ctx.editMessageText('❌ Grupo não encontrado ou sem permissão.').catch(() => {});

    await supabase.from('boost_history').delete().eq('group_id', groupId);
    await supabase.from('payments').delete().eq('group_id', groupId); 
    await supabase.from('groups').delete().eq('id', groupId).eq('user_id', userId);

    try { await ctx.telegram.leaveChat(grupoInfo.telegram_chat_id); } catch (err) { }

    await ctx.editMessageText(`🗑️ O grupo *${grupoInfo.name}* foi removido com sucesso!`, {
        parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Voltar aos Meus Grupos', callback_data: 'meus_grupos' }]] }
    }).catch(() => {});
});

// ==========================================
// 10. CENTRAL DE IMPULSIONAMENTO (BOOST)
// ==========================================
bot.action(/^boost_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const groupId = ctx.match[1];
    
    const { data: grupo, error } = await supabase.from('groups').select('name, boost_tier, boost_expires_at').eq('id', groupId).eq('user_id', ctx.from.id.toString()).single();

    if (error || !grupo) return ctx.editMessageText('❌ Erro ao buscar informações.').catch(() => {});

    const agora = new Date();
    if (grupo.boost_expires_at && new Date(grupo.boost_expires_at) > agora && grupo.boost_tier && grupo.boost_tier !== 'none') {
        const dataExpiracao = new Date(grupo.boost_expires_at);
        const dataFormatada = dataExpiracao.toLocaleDateString('pt-BR') + ' às ' + dataExpiracao.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

        return ctx.editMessageText(`🚀 *Central de Impulsionamento*\n\nGrupo: *${grupo.name}*\nStatus: 🟢 Plano Ativo\n\n⚠️ *Impulso já em andamento!*\nEste grupo tem um plano válido até *${dataFormatada}*.\n\nPara evitar conflitos, aguarde a expiração do plano atual.`, {
            parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Voltar à Lista', callback_data: 'meus_grupos' }]] }
        }).catch(() => {});
    }

    await ctx.editMessageText(`🚀 *Central de Impulsionamento*\n\nGrupo: *${grupo.name}*\nStatus: 🔴 Nenhum plano ativo\n\n👇 *Escolha um plano abaixo:*`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🥉 Bronze (R$ 3,90 / 28h)', callback_data: `pay_bronze_${groupId}` }],
                [{ text: '🥈 Prata (R$ 6,90 / 2 dias)', callback_data: `pay_silver_${groupId}` }],
                [{ text: '🥇 Ouro (R$ 7,90 / 5 dias)', callback_data: `pay_gold_${groupId}` }],
                [{ text: '💎 Diamante (R$ 9,90 / 7 dias)', callback_data: `pay_diamond_${groupId}` }],
                [{ text: '⬅️ Voltar à Lista', callback_data: 'meus_grupos' }]
            ]
        }
    }).catch(() => {});
});

// ==========================================
// 11. GERAR PAGAMENTO PIX
// ==========================================
bot.action(/^pay_(bronze|silver|gold|diamond)_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('A gerar o seu PIX... Aguarde!').catch(() => {});
    const [planType, groupId] = [ctx.match[1], ctx.match[2]];

    const { data: grupoCheck } = await supabase.from('groups').select('boost_expires_at, boost_tier').eq('id', groupId).single();
    if (grupoCheck && grupoCheck.boost_expires_at && new Date(grupoCheck.boost_expires_at) > new Date() && grupoCheck.boost_tier !== 'none') {
        return ctx.editMessageText('⚠️ *Ação Cancelada*\nEste grupo já possui um plano ativo.', { parse_mode: 'Markdown' }).catch(() => {});
    }

    try {
        await ctx.editMessageText('🔄 A gerar a sua cobrança segura via Mercado Pago...').catch(() => {});
        const pixData = await createPixPayment(ctx.from.id.toString(), groupId, planType);
        
        await ctx.reply(`💠 *Pagamento PIX Gerado com Sucesso!*\n\nPlano: *${planType.toUpperCase()}*\n\nPara pagar, **clique no código abaixo para copiá-lo** e cole na aplicação do seu banco.`, { parse_mode: 'Markdown' });
        await ctx.reply(`\`${pixData.pixCopiaECola}\``, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Voltar ao Menu', callback_data: `boost_${groupId}` }]] } });
    } catch (error) {
        console.error("❌ [ERRO] Falha ao comunicar com o banco de dados/Mercado Pago:", error);
        await ctx.reply('❌ Ocorreu um erro. Verifique o terminal para mais detalhes.');
    }
});
    } // Fim da função configurarBot

// ==========================================
// 12. SERVIDOR HTTP (EXIGIDO PELO RENDER E MERCADO PAGO)
// ==========================================
const app = express();
app.use(express.json());

// Rota para o Render checar que o bot está rodando
app.get('/', (req, res) => {
    res.send('🤖 Bot de Divulgação operando com sucesso!');
});

// Rota que recebe os avisos de PIX pago do Mercado Pago
app.post('/webhook', handleWebhook);

// Abre a porta que o Render fornece automaticamente
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Servidor HTTP ativo e rodando na porta ${PORT}`);
});

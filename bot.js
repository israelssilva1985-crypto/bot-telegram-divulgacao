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
                // ⚠️ ATENÇÃO: Confirme se o nome da sua tabela é 'grupos' ou 'groups' 
                // e se a coluna do ID é 'telegram_chat_id' no seu Supabase.
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

        // Deleta todos de uma vez (Batch Delete) para poupar processamento
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
// 👥 ATUALIZADOR DE MEMBROS E LINKS (A cada 12h)
// ==========================================
async function atualizarContagemMembros() {
    console.log('👥 [SISTEMA] Iniciando atualização da contagem de membros e links dos grupos...');

    try {
        const { data: grupos, error } = await supabase.from('groups').select('id, telegram_chat_id, name').eq('status', 'approved');

        if (error || !grupos) {
            console.error('❌ [ERRO] Falha ao buscar grupos para atualizar:', error?.message);
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
                        break; // Se um bot conseguiu, para de tentar os outros e vai pro próximo grupo
                    } catch (err) {
                        continue; // Falhou, tenta o próximo bot
                    }
                }
                
                if (!infoAtualizada) {
                    console.log(`⚠️ [AVISO] Não foi possível ler dados de: ${grupo.name} (Nenhum bot tem permissão)`);
                }
            } catch (err) {
                console.error(`❌ [ERRO] Falha no grupo ${grupo.name}:`, err.message);
            }
            await sleep(1500); // Um delay de segurança um pouco maior para poupar a API do Telegram
        }

        console.log(`✅ [SUCESSO] Atualização concluída! ${atualizados} grupos tiveram links e membros renovados.`);

    } catch (err) {
        console.error('❌ [ERRO] Erro inesperado ao atualizar membros:', err);
    }
}

cron.schedule('0 */12 * * *', atualizarContagemMembros);

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
            // Se o usuário bloqueou o bot DEPOIS de dar start ou deu erro de rede, o catch segura a bronca
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
        const statusIcon = g.status === 'approved' ? '✅' : g.status === 'pending' ? '⏳' : g.status === 'removed' ? '⏸️' : '❌';
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

    // ROTA DE SAÍDA: O bot foi expulso ou perdeu admin
    if (['kicked', 'left', 'member', 'restricted'].includes(newStatus)) {
        console.log(`🚨 [ALERTA] Bot perdeu permissões no grupo: ${chat.title}. Mudando status para removed...`);
        const { data: grupo } = await supabase.from('groups').select('user_id, name').eq('telegram_chat_id', chat.id.toString()).single();

        if (grupo) {
            await supabase.from('groups').update({ status: 'removed' }).eq('telegram_chat_id', chat.id.toString());
            try {
                const aviso = `⚠️ *ALERTA DE SISTEMA*\n\nFui removido ou perdi as minhas permissões de administrador no grupo/canal *${grupo.name}*!\n\nPor conta disso, a divulgação do seu grupo foi **PAUSADA** (Status: SUSPENSO).\n\n♻️ *Como resolver?*\nPara voltar a participar da divulgação, coloque-me novamente como Administrador. Eu detetarei automaticamente e voltarei a divulgar o seu link!`;
                await bot.telegram.sendMessage(grupo.user_id, aviso, { parse_mode: 'Markdown' });
            } catch(e) {}
        }
        return; 
    }

    // ROTA DE ENTRADA: O bot virou admin
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
                try { await ctx.telegram.sendMessage(userId, `⚠️ *Atenção!*\n\nNão consegui ler o link de convite do grupo *${chat.title}*.\nPor favor, me dê a permissão de *"Convidar Usuários via Link"* nas configurações de administrador e adicione novamente.`, { parse_mode: 'Markdown' }); } catch(e){}
                return; 
            }
        }

        const { data: existingGroup } = await supabase.from('groups').select('*').eq('telegram_chat_id', chat.id.toString()).single();

        if (existingGroup) {
            if (existingGroup.status === 'removed') {
                await supabase.from('groups').update({ link: link, status: 'approved', user_id: userId }).eq('telegram_chat_id', chat.id.toString());
                try { await ctx.telegram.sendMessage(userId, `✅ *BOM TRABALHO!*\n\nAs minhas permissões no grupo *${chat.title}* foram restauradas.\n\nStatus alterado para: 🟢 APROVADO.\nEle já voltou para a rotação de divulgação!`, { parse_mode: 'Markdown' }); } catch(e){}
            } 
            else if (existingGroup.status === 'pending') {
                // Alterado para avisar no grupo, pois a pessoa pode não ter iniciado o PV deste bot específico
                try { await ctx.replyWithHTML(`ℹ️ Olá! Notei que este grupo já está <b>aguardando aprovação</b> no nosso sistema por outro bot da rede. Em breve será avaliado!`).catch(()=>null); } catch(e){}
            }
            else if (existingGroup.status === 'approved') {
                // 🔥 A MÁGICA DA AUTO-APROVAÇÃO FICA AQUI:
                try { await ctx.replyWithHTML(`🎉 <b>Auto-Aprovado!</b>\n\nEste grupo já faz parte da nossa rede de parceiros! Como já foi aprovado anteriormente, eu já estou pronto para começar as divulgações aqui.`).catch(()=>null); } catch(e){}
            }
        } else {
            const { error } = await supabase.from('groups').insert([{ user_id: userId, telegram_chat_id: chat.id.toString(), name: chat.title, link: link, status: 'pending' }]);

            if (!error) {
                console.log(`✅ [INFO] Grupo ${chat.title} cadastrado e pendente de aprovação.`);
                try {
                    await ctx.telegram.sendMessage(userId, `✅ Sucesso! Detectei que você me adicionou como Admin em:\n*${chat.title}*\n\nStatus: ⏳ Pendente de Aprovação.\nFique de olho, avisarei por aqui quando for aprovado!`, { parse_mode: 'Markdown' });
                } catch (err) {
                    try {
                        const botUsername = ctx.botInfo.username;
                        const avisoGrupo = `✅ **Fui ativado com sucesso!**\n\n[${username}](tg://user?id=${userId}), o seu grupo foi cadastrado e está ⏳ **Pendente de Aprovação**.\n\n👉 Por favor, clique aqui: @${botUsername} e aperte em **COMEÇAR** para ter acesso ao painel do seu grupo e receber os avisos!`;
                        await ctx.telegram.sendMessage(chat.id, avisoGrupo, { parse_mode: 'Markdown' });
                    } catch (e) {}
                }
            }
        }
    }
});

// ==========================================
// 7. MOTOR DE DIVULGAÇÃO (FILA INTERCALADA POR HORA)
// ==========================================

// Trava de segurança: impede que o mesmo bot rode duas vezes ao mesmo tempo
const emExecucao = { 0: false, 1: false, 2: false };

async function rodarDivulgacao(botAtual, botIndex) {
    // Se o bot já estiver divulgando (clonagem de cron), ele ignora
    if (emExecucao[botIndex]) {
        console.log(`⚠️ [AVISO] Bot ${botIndex + 1} já está em execução. Ignorando chamada duplicada.`);
        return;
    }
    emExecucao[botIndex] = true;

    try {
        console.log(`🔄 [SISTEMA] Iniciando rotina de postagem para o Bot ${botIndex + 1}...`);
        
        const { data: todosGrupos, error: errTop } = await supabase.from('groups').select('*').eq('status', 'approved');

        if (errTop || !todosGrupos || todosGrupos.length === 0) {
            console.log(`⚠️ [INFO] Bot ${botIndex + 1}: Nenhum grupo aprovado encontrado.`);
            emExecucao[botIndex] = false;
            return;
        }

        const getPeso = (grupo) => {
            const plano = (grupo.plan || grupo.boost_tier || '').toLowerCase();
            if (['diamante', 'diamond'].includes(plano)) return 4;
            if (['ouro', 'gold', 'vip', 'premium'].includes(plano)) return 3;
            if (['prata', 'silver'].includes(plano)) return 2;
            if (['bronze'].includes(plano)) return 1;
            return 0; 
        };

        // Mantido exatamente como o seu original (sem emojis visíveis)
        const getEmoji = (peso) => ['‍', '‍', '‍', '‍', '‍'][peso] || '‍';

        const alvosOrdenados = todosGrupos
            .map(g => ({ ...g, membros: g.member_count || 0 }))
            .sort((a, b) => b.membros - a.membros);

        // VIPs ordenados pelo plano mais alto, Free embaralhados
        const vipLinks = alvosOrdenados.filter(g => getPeso(g) > 0).sort((a, b) => getPeso(b) - getPeso(a));
        const freeLinks = alvosOrdenados.filter(g => getPeso(g) === 0).sort(() => Math.random() - 0.5);

        const blocos = [];
        let vIndex = 0;
        let fIndex = 0;
        const TOTAL_POR_LISTA = 20;
        const MAX_VIPS_POR_LISTA = 10; 

        // Calcula quantas listas únicas precisamos gerar para cobrir todos os grupos
        const totalListas = Math.max(1, Math.ceil(alvosOrdenados.length / TOTAL_POR_LISTA));

        // Monta as listas garantindo os VIPs SEMPRE no topo
        for (let i = 0; i < totalListas; i++) {
            let blocoVips = [];
            
            // Pega até 10 VIPs. O "%" faz eles se repetirem caso você tenha poucos VIPs, 
            // garantindo que eles apareçam no topo de TODAS as mensagens enviadas!
            if (vipLinks.length > 0) {
                const qtdVipsNaLista = Math.min(MAX_VIPS_POR_LISTA, vipLinks.length);
                for (let j = 0; j < qtdVipsNaLista; j++) {
                    blocoVips.push(vipLinks[vIndex % vipLinks.length]);
                    vIndex++;
                }
            }

            let blocoFree = [];
            let vagasFree = TOTAL_POR_LISTA - blocoVips.length;
            
            // Preenche o resto (abaixo dos VIPs) com os grupos grátis
            if (freeLinks.length > 0) {
                for (let j = 0; j < vagasFree; j++) {
                    blocoFree.push(freeLinks[fIndex % freeLinks.length]);
                    fIndex++;
                }
            }

            // Une o topo (VIPs) + resto (Free)
            let blocoFinal = [...blocoVips, ...blocoFree];
            
            // Segurança: Se você tiver menos de 20 grupos no banco todo, impede duplicação na mesma lista
            blocoFinal = [...new Set(blocoFinal)];

            if (blocoFinal.length > 0) blocos.push(blocoFinal);
        }
        const botUsername = botAtual.botInfo ? botAtual.botInfo.username : 'divulga_parceiros_OFC_bot';
        const textoMensagem = `💯 <b>Grupos do Telegram</b>\n\n✅ Entre em nosso site e aumente seu alcance: https://grupolink.site/\n\n🔥 <b>Adicione nossos bots no seu canal ou grupo:</b>\n🤖 @divulga_parceiros_OFC_bot\n🤖 @divulga_grupos_bot\n🤖 @divulgacao_de_links_bot`;
        
        let enviosComSucesso = 0;

        for (let i = 0; i < alvosOrdenados.length; i++) {
            const target = alvosOrdenados[i];
            
            // Pega o bloco atual na ordem original intocada
            let blocoAtual = blocos[i % blocos.length]; 
            
            let tecladoBotoes = blocoAtual.map(grupo => {
                const urlSegura = (grupo.link && grupo.link.startsWith('http')) ? grupo.link : 'https://grupolink.site/';
                return [{ text: `${getEmoji(getPeso(grupo))} ${grupo.name}`, url: urlSegura }];
            });
            
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
                // Ignora erros de permissão silenciosamente
            }
            
            // Pausa programada para evitar Rate Limit do Telegram
            await new Promise(resolve => setTimeout(resolve, 3000));
        }

        console.log(`✅ [SUCESSO] Divulgação Bot ${botIndex + 1} concluída! ${enviosComSucesso} grupos atualizados.`);
    
    } catch (error) {
        console.log(`❌ [ERRO] Falha geral no Bot ${botIndex + 1}:`, error);
    } finally {
        // Libera o bot para a próxima hora
        emExecucao[botIndex] = false;
    }
}

// 🕒 Agendamento intercalado
const cronsDeHorario = [
    '0 0,4,8,12,16,20 * * *', // Bot 1 (00:00, 04:00, 08:00...)
    '0 1,5,9,13,17,21 * * *', // Bot 2 (01:00, 05:00, 09:00...)
    '0 2,6,10,14,18,22 * * *' // Bot 3 (02:00, 06:00, 10:00...)
];

// Impede o sistema de agendar os mesmos horários várias vezes caso o servidor reinicie
if (!global.cronsRegistrados) {
    bots.forEach((botInstancia, index) => {
        if (cronsDeHorario[index]) {
            cron.schedule(cronsDeHorario[index], () => {
                rodarDivulgacao(botInstancia, index);
            }, {
                scheduled: true,
                timezone: "America/Sao_Paulo" // <--- Força o horário do Brasil
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
                    break; // Enviou com um bot? Pode parar.
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
                user_id: ctx.from.id.toString() // 🔥 O ID do usuário agora é salvo aqui!
            });
            
            if (!error) {
                // O bot vai TENTAR mandar no privado da pessoa primeiro
try {
    await ctx.telegram.sendMessage(
        ctx.from.id, 
        `✅ O grupo <b>${ctx.chat.title}</b> foi registrado e enviado para aprovação no site!`, 
        { parse_mode: 'HTML' }
    );
} catch (erro) {
    // SE DER ERRO (ex: ela nunca deu /start no bot), ele desiste do PV e manda no Grupo
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

import { Telegraf } from 'telegraf';
import cron from 'node-cron';
import { supabase } from './db.js';
import dotenv from 'dotenv';
import express from 'express';
import { createPixPayment, handleWebhook } from './mercadopago.js';

dotenv.config();

export const bot = new Telegraf(process.env.BOT_TOKEN);

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
                // Puxa as infos reais do grupo no Telegram neste exato momento
                const chatInfo = await bot.telegram.getChat(grupo.telegram_chat_id);
                const membros = await bot.telegram.getChatMembersCount(grupo.telegram_chat_id);
                
                let linkAtualizado = '';
                if (chatInfo.username) {
                    // Se o grupo é público, o link é o @username
                    linkAtualizado = `https://t.me/${chatInfo.username}`;
                } else if (chatInfo.invite_link) {
                    // JEITO SEGURO: Se for privado e o Telegram já tiver um link ativo devolvido, usa ele sem revogar!
                    linkAtualizado = chatInfo.invite_link;
                } else {
                    // ÚLTIMO CASO: Só cria um link novo (e revoga o antigo) se realmente não existir nenhum link disponível
                    linkAtualizado = await bot.telegram.exportChatInviteLink(grupo.telegram_chat_id);
                }

                await supabase.from('groups').update({ 
                    member_count: membros,
                    link: linkAtualizado 
                }).eq('id', grupo.id);
                
                atualizados++;
            } catch (err) {
                console.log(`⚠️ [AVISO] Não foi possível ler dados de: ${grupo.name} (Bot sem permissão de convite ou expulso)`);
            }
            await sleep(300); // Um delay de segurança um pouco maior para poupar a API do Telegram
        }

        console.log(`✅ [SUCESSO] Atualização concluída! ${atualizados} grupos tiveram links e membros renovados.`);

    } catch (err) {
        console.error('❌ [ERRO] Erro inesperado ao atualizar membros:', err);
    }
}

atualizarContagemMembros();
cron.schedule('0 */12 * * *', atualizarContagemMembros);

// ==========================================
// 1. COMANDO /start
// ==========================================
bot.start(async (ctx) => {
    if (ctx.chat.type === 'private') {
        const userId = ctx.from.id.toString();
        const username = ctx.from.username || ctx.from.first_name || 'Sem_Nome';

        const { error } = await supabase.from('users').upsert({ telegram_id: userId, username: username }, { onConflict: 'telegram_id' });

        if (error) {
            console.error("❌ [ERRO] Erro ao salvar usuário no banco:", error.message);
        } else {
            console.log(`✅ [INFO] Usuário ${username} registrado/atualizado no sistema.`);
        }

        const botUsername = ctx.botInfo.username;
        const mensagem = `Olá! 🤖\n\nPara participar da nossa rede de divulgação, adicione este bot ao seu Grupo ou Canal como Administrador.\n\nDepois que aprovarmos no sistema, seu grupo entrará na nossa rotação automática!`;

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
// 7. MOTOR DE DIVULGAÇÃO (EXTREMAMENTE OTIMIZADO)
// ==========================================
cron.schedule('0 */4 * * *', async () => {
    console.log('🔄 [SISTEMA] Iniciando rotina de postagem inteligente (A cada 4 horas)...');
    
    const { data: todosGrupos, error: errTop } = await supabase.from('groups').select('*').eq('status', 'approved');

    if (errTop || !todosGrupos || todosGrupos.length === 0) return console.log('⚠️ [INFO] Nenhum grupo aprovado encontrado para a rotação.');

    const getPeso = (grupo) => {
        const plano = (grupo.plan || grupo.boost_tier || '').toLowerCase();
        if (['diamante', 'diamond'].includes(plano)) return 4;
        if (['ouro', 'gold'].includes(plano)) return 3;
        if (['prata', 'silver'].includes(plano)) return 2;
        if (plano === 'bronze') return 1;
        return 0; 
    };

    const getEmoji = (peso) => ['‍', '‍', '‍', '‍', '‍'][peso] || '‍';

    // OTIMIZAÇÃO: Usa a coluna member_count do banco. Sem loops infinitos no Telegram!
    console.log('📊 [INFO] Organizando blocos VIP e Free com base no tamanho dos grupos...');
    const alvosOrdenados = todosGrupos
        .map(g => ({ ...g, membros: g.member_count || 0 }))
        .sort((a, b) => b.membros - a.membros);

    const vipLinks = alvosOrdenados.filter(g => getPeso(g) > 0).sort(() => Math.random() - 0.5).sort((a, b) => getPeso(b) - getPeso(a));
    const freeLinks = alvosOrdenados.filter(g => getPeso(g) === 0).sort(() => Math.random() - 0.5);

    const blocos = [];
    let vIndex = 0, fIndex = 0;

    while (vIndex < vipLinks.length || fIndex < freeLinks.length) {
        let blocoVips = vipLinks.slice(vIndex, vIndex + 10);
        vIndex += 10;
        
        let slotsForFree = 20 - blocoVips.length;
        let blocoFree = freeLinks.slice(fIndex, fIndex + slotsForFree);
        fIndex += slotsForFree;

if (blocoVips.length + blocoFree.length < 20 && vIndex < vipLinks.length) {
             let missing = 20 - (blocoVips.length + blocoFree.length);
             let extraVips = vipLinks.slice(vIndex, vIndex + missing);
             vIndex += missing;
             blocoVips = blocoVips.concat(extraVips);
        }

        let bloco = [...blocoVips, ...blocoFree];
        
        // 🚀 A MÁGICA: Preencher se faltar para dar 20 cravado!
        if (bloco.length > 0 && bloco.length < 20 && alvosOrdenados.length >= 20) {
             let missingCount = 20 - bloco.length;
             // Busca grupos extras que ainda NÃO estão neste bloco (para evitar duplicatas)
             let gruposExtras = alvosOrdenados
                 .filter(g => !bloco.some(b => b.id === g.id))
                 .sort(() => Math.random() - 0.5) // Pega aleatoriamente para misturar
                 .slice(0, missingCount);
             
             bloco = [...bloco, ...gruposExtras];
        }

        if (bloco.length > 0) blocos.push(bloco);
    }

    const botUsername = bot.botInfo ? bot.botInfo.username : 'divulga_parceiros_OFC_bot';
    const textoMensagem = `💯 <b>Grupos do Telegram</b>\n\n✅ Entre em nosso site e aumente seu alcançe: https://grupolink.site/\n\n🔥 Adicione no seu canal ou grupo: @${botUsername}`;
    let enviosComSucesso = 0;

    for (let i = 0; i < alvosOrdenados.length; i++) {
        const target = alvosOrdenados[i];
        let blocoAtual = [...blocos[i % blocos.length]]; 
        blocoAtual.sort((a, b) => getPeso(b) - getPeso(a) || Math.random() - 0.5);
        
        let tecladoBotoes = blocoAtual.map(grupo => {
    const urlSegura = (grupo.link && grupo.link.startsWith('http')) ? grupo.link : 'https://grupolink.site/';
    return [{ text: `${getEmoji(getPeso(grupo))} ${grupo.name}`, url: urlSegura }];
});
        tecladoBotoes.push([
            { text: '✅ Adicionar', url: `https://t.me/${botUsername}?startgroup=true` },
            { text: '🌐 Lista Completa', url: 'https://grupolink.site/grupos-do-bot' }
        ]);

        try {
            const mensagemEnviada = await bot.telegram.sendMessage(target.telegram_chat_id, textoMensagem, { 
                parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: tecladoBotoes }
            });

            await bot.telegram.pinChatMessage(target.telegram_chat_id, mensagemEnviada.message_id, { disable_notification: true }).catch(() => {});
            enviosComSucesso++;
            await sleep(3000); 
            
        } catch (err) {
            if ((err.code === 403 || err.code === 400) && !err.message.includes('parse entities')) {
                await supabase.from('groups').update({ status: 'removed' }).eq('telegram_chat_id', target.telegram_chat_id);
                try {
                    const aviso = `⚠️ *ALERTA DE DIVULGAÇÃO*\n\nTentei enviar a lista no seu grupo *${target.name}*, mas fui bloqueado!\nO seu grupo foi **PAUSADO** (Status: removed). Corrija as permissões.`;
                    await bot.telegram.sendMessage(target.user_id, aviso, { parse_mode: 'Markdown' });
                } catch(e) {}
            }
        }
    }
    console.log(`✅ [SUCESSO] Divulgação concluída! ${enviosComSucesso} grupos atualizados.`);
});

// ==========================================
// 8. DETECTOR DE APROVAÇÃO/REJEIÇÃO (REALTIME)
// ==========================================
supabase.channel('mudancas-de-status')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'groups' }, async (payload) => {
        const { status: statusAntigo } = payload.old;
        const { status: statusNovo, user_id: userId, name: nomeGrupo } = payload.new;

        if (statusAntigo !== statusNovo) {
            if (statusNovo === 'approved') {
                try { await bot.telegram.sendMessage(userId, `🎉 *Boas notícias!*\n\nSeu grupo/canal *${nomeGrupo}* foi **APROVADO**! Ele já está na nossa rotação.`, { parse_mode: 'Markdown' }); } catch (err) {}
            } else if (statusNovo === 'rejected') {
                try { await bot.telegram.sendMessage(userId, `❌ *Aviso!*\n\nSeu grupo/canal *${nomeGrupo}* foi **REJEITADO** no nosso sistema.`, { parse_mode: 'Markdown' }); } catch (err) {}
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

// ==========================================
// 🌐 SERVIDOR WEBHOOK E GRACEFUL SHUTDOWN (DESLIGAMENTO SEGURO)
// ==========================================
const app = express();

// Permite que o bot entenda a mensagem que o Mercado Pago vai enviar
app.use(express.json()); 

// Resposta para o UptimeRobot não achar que o bot caiu (Fica Verde)
app.get('/', (req, res) => res.send('Bot está online e respirando! 🤖'));

// Essa é a rota (o link) que o Mercado Pago vai chamar
app.post('/webhook', handleWebhook);

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`🌐 [SISTEMA] Servidor Webhook rodando e escutando na porta ${PORT}!`);
});

// Desligamento Seguro: Evita corrupção no banco de dados
process.once('SIGINT', () => {
    console.log('🛑 [SISTEMA] Sinal de interrupção recebido. Desligando bot...');
    bot.stop('SIGINT');
    server.close();
});

process.once('SIGTERM', () => {
    console.log('🛑 [SISTEMA] Sinal de finalização recebido. Desligando bot...');
    bot.stop('SIGTERM');
    server.close();
});

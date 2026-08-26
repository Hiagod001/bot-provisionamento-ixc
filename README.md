# Bot Telegram de Provisionamento IXC

Bot em Node.js para guiar o tecnico pelo provisionamento de ONU no IXC Provedor.

## Fluxo do tecnico

1. Escolhe o tipo de servico: instalacao, mudanca de endereco, troca de equipamento ou troca de titularidade.
2. Informa os 7 ultimos caracteres do serial da ONU.
3. O bot executa a consulta equivalente ao botao `Consultar todas` e busca a ONU aguardando autorizacao no IXC.
4. Em mudanca de endereco, se existir cadastro antigo dessa ONU em `radpop_radio_cliente_fibra`, o bot obriga remover o cadastro antigo antes de seguir.
5. Em troca de equipamento, o bot busca o equipamento antigo pelo contrato escolhido, limpa o MAC do login, remove o cadastro antigo e reaproveita a mesma caixa/porta para a ONU nova.
6. Em troca de titularidade, o bot busca a ONU ja provisionada, escolhe o novo cliente/contrato/login, tenta ativar o novo contrato, limpa o MAC do login antigo e transfere o cadastro de fibra para o novo titular.
7. Tecnico envia a localizacao atual pelo Telegram quando o servico exigir nova caixa.
8. Bot lista caixas ativas em ate 300 metros, ordenadas pela distancia.
9. Tecnico escolhe a caixa correta no menu.
10. Bot lista as portas livres da caixa.
11. Tecnico escolhe a porta livre no menu.
12. Tecnico informa ID do cliente.
13. Bot lista os contratos do cliente com endereco/status.
14. Tecnico escolhe o contrato correto.
15. Bot busca o login PPPoE do contrato.
16. Bot lista scripts/perfis de provisionamento conforme a OLT.
17. Tecnico confirma, o bot valida se o contrato ja esta ativo e so chama a ativacao quando necessario.
18. Bot cadastra a ONU e executa a autorizacao pela API.
19. Depois da autorizacao, cria o atendimento de assunto 7; o workflow gera a OS.
20. Bot finaliza a OS com resposta 5 e diagnostico 507, marca `Finaliza atendimento` e salva.

## Configuracao

Copie `.env.example` para `.env` e preencha:

```env
TELEGRAM_BOT_TOKEN=token_do_bot
IXC_BASE_URL=https://seudominio.com.br/webservice/v1
IXC_TOKEN=token_do_usuario_webservice_ixc
IXC_SELF_SIGNED=true
DRY_RUN=true
```

Comece com `DRY_RUN=true`. Nesse modo o bot mostra o payload final, mas nao grava no IXC.

## Comandos

```powershell
npm.cmd install
npm.cmd start
```

Se quiser reiniciar automatico em desenvolvimento:

```powershell
npm.cmd run dev
```

## Endpoints/tabelas IXC usados

Base oficial: `https://SEU_DOMINIO/webservice/v1/{tabela}`.

| Etapa | Tabela IXC | Uso |
| --- | --- | --- |
| ONU aguardando autorizacao | `fh_onu_nao_autorizadas` | Buscar pelo final do serial/MAC e remover da fila apos provisionar |
| OLT/transmissor | `radpop_radio` | Identificar OLT e fabricante/modelo |
| Caixa de atendimento | `rad_caixa_ftth` | Buscar caixa por ID ou descricao |
| Cliente | `cliente` | Conferir nome do cliente |
| Contratos | `cliente_contrato` | Listar contratos do cliente |
| Login PPPoE | `radusuarios` | Buscar login vinculado ao contrato |
| Scripts/perfis | `radpop_radio_cliente_fibra_perfil` | Listar scripts conforme a OLT; OLT 01/02 PMS exibem apenas bridge e integrada correspondentes, e Huawei exibe apenas os perfis exclusivos bridge e integrada |
| Cadastro/provisionamento da ONU | `radpop_radio_cliente_fibra` | Criar a ONU com OLT, caixa, porta, contrato, login e perfil |
| Autorizacao na OLT | `fh_onu_nao_autorizadas_22396` | Autorizar pela API usando o ID original da ONU pendente |
| Atendimento de provisionamento | `su_ticket` | Criar atendimento com assunto 7 e processo 71 |
| Ordem de servico | `su_oss_chamado` | Localizar a OS gerada pelo workflow do atendimento |
| Finalizacao da OS | `su_oss_chamado_fechar` | Executar Acoes > Finalizar, resposta 5, diagnostico 507 e `finaliza_processo=S` |
| Ativacao de contrato | `cliente_contrato_ativar_cliente` | Tentar ativar contrato em instalacao e titularidade somente quando o contrato ainda nao estiver ativo |
| Limpeza de MAC | `radusuarios_25452` | Limpar MAC do login na troca de equipamento e do login antigo na troca de titularidade |

## Observacoes importantes

- O usuario de API no IXC precisa ter permissao para consultar e gravar nessas tabelas.
- O token do Telegram e o token do IXC ficam no `.env`, que esta no `.gitignore`.
- Se o IXC usar certificado autoassinado, mantenha `IXC_SELF_SIGNED=true`.
- Para limitar quem usa o bot, preencha `ALLOWED_TELEGRAM_IDS` com os IDs dos tecnicos separados por virgula.

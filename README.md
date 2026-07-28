# Cofre de notas

Aplicação Next.js multiusuário para notas armazenadas em SQLite com os campos
sensíveis criptografados por usuário.

## Estrutura

- `src/app`: App Router, página e Route Handlers da API;
- `src/components`: interface React; componentes podem permanecer em
  JavaScript quando tipagem não agrega valor;
- `src/server`: criptografia, SQLite, sessões e regras dos cofres;
- `src/proxy.ts`: CSP com nonce e cabeçalhos de segurança;
- `test`: teste de integração que sobe o servidor Next.js real;
- `Dockerfile`: imagem standalone de produção;
- `Dockerfile.test`: build e suíte isolada.

O build usa `output: "standalone"` do Next.js. O banco persistente fica em
`data/notes.sqlite`, ao lado dos arquivos Compose. A pasta `data/` não é
versionada nem enviada ao contexto de build das imagens.

## Árvore de páginas

As notas funcionam como páginas organizadas em uma árvore:

- o botão hambúrguer abre a árvore compacta de páginas e subpáginas sobre o
  editor; o menu começa recolhido em qualquer tamanho de tela;
- o `+` do cabeçalho cria uma página na raiz e o `+` exibido ao passar o mouse
  sobre uma página cria uma subpágina;
- os ramos podem ser recolhidos e expandidos;
- o seletor **Dentro de** move a página para a raiz ou para outra página;
- páginas podem ter quantos níveis forem necessários;
- ciclos são rejeitados pelo servidor;
- excluir uma página remove toda a subárvore e seus anexos.

O editor usa toda a janela, com a barra de formatação fixa durante a rolagem.
O menu fecha ao selecionar uma página, tocar fora dele ou pressionar `Esc`.

A coluna relacional `parent_id` permite montar a árvore e aplicar a exclusão em
cascata. A mesma relação também fica dentro do payload criptografado: se alguém
alterar diretamente a hierarquia no SQLite, a verificação AES-GCM detecta a
divergência. Um banco copiado ainda pode revelar quais identificadores estão
relacionados, mas não os títulos nem o conteúdo dessas páginas.

## Editor e formato

O conteúdo é editado visualmente com Quill (WYSIWYG), convertido para Markdown
antes de ser enviado à API e reconstruído no editor ao abrir a nota. O HTML
gerado a partir do Markdown é sanitizado antes da renderização.

O Markdown fica dentro do payload criptografado no SQLite; ele não é gravado
como um arquivo `.md` legível no volume. Notas da versão anterior, armazenadas
como Quill Delta, continuam abrindo e são convertidas para Markdown no próximo
salvamento.

Imagens e arquivos podem ser adicionados pelo botão abaixo do editor. Cada
anexo é salvo na tabela `attachments`, vinculado à nota e ao usuário. Nome,
tipo MIME e conteúdo usam campos criptografados separados, permitindo listar os
anexos sem descriptografar os bytes do arquivo.

- links HTTP/HTTPS arrastados para o editor viram links Markdown dentro do
  conteúdo criptografado da nota;
- arquivos arrastados para o editor seguem o mesmo fluxo criptografado do botão
  de anexos;
- protocolos ativos como `javascript:` e `data:` são rejeitados no drop;
- PNG, JPEG, GIF, WebP e AVIF são exibidos dentro do editor;
- arquivos genéricos aparecem como links de consulta e são baixados como
  `application/octet-stream`, independentemente do MIME informado;
- o limite é de 50 MiB por arquivo e 500 MiB de anexos por nota;
- excluir uma nota remove seus anexos em cascata;
- excluir um anexo pela lista também remove suas referências do conteúdo.

## Garantias e limites

- Título e conteúdo são criptografados com AES-256-GCM antes de chegarem ao
  SQLite.
- Metadados e bytes dos anexos também são criptografados com AES-256-GCM e
  associados criptograficamente ao usuário, à nota e ao identificador do anexo.
- Cada usuário possui uma chave de dados própria, protegida por uma chave
  derivada da senha com `scrypt`.
- Senhas e chaves abertas não são persistidas.
- Não existem administradores nem convites. Qualquer pessoa com acesso ao
  serviço pode criar uma conta, e cada conta acessa somente o próprio cofre.
- Não existe recuperação de senha. Perder a senha significa perder
  definitivamente o conteúdo.
- A criptografia protege os dados em repouso. Um processo ou navegador
  comprometido enquanto o cofre estiver aberto ainda poderá observar o
  conteúdo.

## Execução

Todo o projeto roda dentro do Docker. O host precisa apenas de Docker com
Compose; não é necessário instalar Node.js, npm, OpenSSL ou SQLite.

```bash
./deploy.sh
```

Acesse `http://127.0.0.1:3002`. Na tela inicial, escolha **Criar novo cofre**,
informe um nome de usuário e uma senha mestra. Não existe token de configuração,
administrador global ou fluxo de convites.

O padrão publica a porta em todas as interfaces. Em outro dispositivo da rede,
use o IP do servidor, por exemplo `http://192.168.1.190:3002`. O endereço
`0.0.0.0` representa o binding e não deve ser usado como URL.

Variáveis disponíveis:

| Variável | Padrão | Finalidade |
| --- | --- | --- |
| `PORT` | `3001` | Porta HTTP |
| `HOSTNAME` | `0.0.0.0` | Interface interna do container |
| `NOTES_BIND_ADDRESS` | `0.0.0.0` | Interface publicada no host |
| `NOTES_PORT` | `3002` | Porta publicada no host |
| `NOTES_DB` | `data/notes.sqlite` | Caminho do SQLite |
| `NOTES_HTTPS` | `0` | Use `1` atrás de HTTPS para ativar cookie `Secure` |
| `NOTES_IDLE_MINUTES` | `15` | Minutos sem interação antes do bloqueio automático |

Para acompanhar ou encerrar:

```bash
docker compose -f docker-compose.production.yml logs -f notes
docker compose -f docker-compose.production.yml down
```

`docker compose down` preserva `data/notes.sqlite`. Faça backup da pasta `data`
antes de atualizações importantes. Como o padrão disponibiliza HTTP na rede,
use apenas em uma rede confiável. Para restringir novamente à própria máquina,
execute com `NOTES_BIND_ADDRESS=127.0.0.1`. Para uso remoto, coloque o serviço
atrás de HTTPS, defina `NOTES_HTTPS=1` e não exponha diretamente a porta do
container.

## Imagens Docker

### Testes

A imagem de testes instala as dependências a partir do lockfile e executa a
suíte em um ambiente limpo:

```bash
docker compose -f docker-compose.test.yml run --build --rm tests
```

O Compose de testes desabilita a rede, remove capabilities, deixa o filesystem
da imagem somente para leitura e disponibiliza apenas `/tmp` em memória. Nenhum
volume persistente ou secret é usado; o SQLite temporário desaparece ao final.

Também é possível executar a imagem diretamente:

```bash
docker build -f Dockerfile.test -t notes:test .
docker run --rm --network none --read-only --tmpfs /tmp notes:test
```

### Produção

A imagem de produção contém apenas a aplicação e as dependências necessárias,
usa o servidor standalone do Next.js, executa como usuário não-root e possui
healthcheck:

```bash
./deploy.sh
```

O deploy valida os dois arquivos Compose, executa os testes isolados, constrói
a imagem de produção, atualiza os serviços e aguarda o healthcheck. Opções:

```bash
# Porta ou endereço de publicação
NOTES_PORT=8080 NOTES_BIND_ADDRESS=127.0.0.1 ./deploy.sh

# Cookies Secure quando houver um proxy HTTPS
NOTES_HTTPS=1 ./deploy.sh

# Bloquear após 5 minutos sem interação na tela
NOTES_IDLE_MINUTES=5 ./deploy.sh

# Somente para uma repetição em que os testes já foram executados
SKIP_TESTS=1 ./deploy.sh
```

O arquivo [docker-compose.production.yml](docker-compose.production.yml) aplica
filesystem somente para leitura, capabilities removidas, limite de processos,
limite de memória, rotação de logs e bind mount persistente em `./data`.

## Operação

- O cofre bloqueia após o período configurado sem teclado, mouse, toque ou
  rolagem, no logout ou sempre que o processo reinicia. Antes do bloqueio por
  inatividade, o frontend conclui o autosave pendente e encerra a sessão no
  backend.
- Enquanto existe atividade na tela, um heartbeat autenticado mantém a sessão
  do servidor ativa. O padrão é 15 minutos e pode ser alterado com
  `NOTES_IDLE_MINUTES`.
- O cadastro é aberto para quem alcançar o serviço. Em uma publicação externa,
  limite o acesso na rede ou em um proxy HTTPS.
- O SQLite usa WAL. Para backup consistente, pare o container antes de copiar o
  diretório `data` ou utilize uma ferramenta de backup compatível com SQLite.

Não há fluxo de execução ou testes diretamente no host; use sempre os comandos
Docker Compose documentados acima.

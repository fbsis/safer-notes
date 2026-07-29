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
- `Dockerfile.test`: build e suíte isolada;
- `docker-compose.yml`: instalação pública usando a imagem `latest`;
- `docker.compose.dev.yml`: build e execução local a partir do código;
- `docker-compose.test.yml`: testes automatizados em container isolado.

O build usa `output: "standalone"` do Next.js. O banco persistente fica em
`data/notes.sqlite` e os anexos criptografados ficam em `data/attachments`,
ao lado dos arquivos Compose. A pasta `data/` não é versionada nem enviada ao
contexto de build das imagens.

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

Imagens e arquivos podem ser adicionados pelo botão abaixo do editor. A tabela
`attachments` mantém somente os identificadores relacionais, os metadados
criptografados e os campos técnicos da criptografia. Os bytes criptografados
ficam em `data/attachments/<id>.bin`; o nome físico é apenas um UUID aleatório,
sem nome original, extensão real, tipo MIME ou conteúdo legível.

Cada arquivo possui um envelope binário com versão, IV, tag de autenticação e
ciphertext AES-256-GCM. Nome original e tipo MIME permanecem nos metadados
criptografados do SQLite. A autenticação criptográfica associa os bytes ao
usuário, à nota e ao ID do anexo, portanto trocar arquivos entre IDs ou editar
seus bytes faz a leitura falhar.

- links HTTP/HTTPS arrastados para o editor viram links Markdown dentro do
  conteúdo criptografado da nota;
- arquivos arrastados para o editor seguem o mesmo fluxo criptografado do botão
  de anexos;
- imagens e arquivos colados da área de transferência também são enviados como
  anexos criptografados, em vez de virar base64 dentro do Markdown;
- imagens base64 que já tenham entrado no editor são detectadas no salvamento,
  enviadas à tabela de anexos e substituídas pela URL interna criptografada;
- protocolos ativos como `javascript:` e `data:` são rejeitados no drop;
- PNG, JPEG, GIF, WebP e AVIF são exibidos dentro do editor;
- imagens também aparecem em uma galeria abaixo do editor; ao abrir uma
  miniatura, o modal permite navegar pelas demais com botões ou setas do
  teclado;
- arquivos genéricos aparecem como links de consulta e são baixados como
  `application/octet-stream`, independentemente do MIME informado;
- o limite é de 50 MiB por arquivo e 500 MiB de anexos por nota;
- excluir uma nota remove seus anexos em cascata;
- excluir um anexo pela lista também remove suas referências do conteúdo.

Ao abrir um banco criado por uma versão anterior, o serviço copia os BLOBs já
criptografados para `data/attachments` sem descriptografá-los e só depois
remove do esquema as colunas de conteúdo. A migração é idempotente: se for
interrompida, arquivos completos já copiados são verificados e reutilizados na
próxima inicialização.

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

### Instalação sem clonar o repositório

A imagem pública é publicada em `ghcr.io/fbsis/safer-notes`. Para instalar,
baixe somente o arquivo `docker-compose.yml`:

```bash
mkdir safer-notes
cd safer-notes
curl -fsSLO \
  https://raw.githubusercontent.com/fbsis/safer-notes/main/docker-compose.yml
docker compose up -d
```

O arquivo usa exclusivamente a imagem `ghcr.io/fbsis/safer-notes:latest`; não
há `build:` nem dependência do código-fonte. A política `pull_policy: always`
consulta a imagem mais recente sempre que `docker compose up -d` é executado.
O banco é criado em `./data/notes.sqlite` e os anexos em
`./data/attachments`, no mesmo diretório do Compose.
Ao iniciar, a imagem ajusta a propriedade e os modos da pasta e dos arquivos
SQLite/anexos e, em seguida, remove os privilégios antes de executar o Next.js
como UID/GID `1000`.

Porta, binding, tempo de inatividade e diretório também podem ser substituídos:

```bash
NOTES_PORT=8080 \
NOTES_BIND_ADDRESS=127.0.0.1 \
NOTES_IDLE_MINUTES=5 \
NOTES_DATA_DIR=/srv/safer-notes/data \
docker compose up -d
```

As imagens são publicadas para `linux/amd64` e `linux/arm64`. Cada push aceito
na branch `main` gera tags imutáveis do commit/build e também atualiza `latest`.

Para atualizar uma instalação existente:

```bash
docker compose up -d
```

### Desenvolvimento e testes locais

Quem clonou o repositório deve usar `docker.compose.dev.yml` para construir e
executar o código local:

```bash
docker compose -f docker.compose.dev.yml up -d --build
```

O script abaixo executa os testes isolados, constrói a imagem local, atualiza o
serviço de desenvolvimento e aguarda o healthcheck:

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
| `NOTES_ATTACHMENTS_DIR` | `data/attachments` | Diretório dos anexos criptografados |
| `NOTES_HTTPS` | `0` | Use `1` atrás de HTTPS para ativar cookie `Secure` |
| `NOTES_IDLE_MINUTES` | `15` | Minutos sem interação antes do bloqueio automático |
| `NOTES_MAX_NOTE_MB` | `50` | Limite do título + Markdown, entre 1 e 50 MiB |

Para acompanhar ou encerrar:

```bash
docker compose -f docker.compose.dev.yml logs -f notes
docker compose -f docker.compose.dev.yml down
```

`docker compose down` preserva toda a pasta `data`. O banco e a pasta
`attachments` formam um único conjunto: sempre copie os dois no mesmo backup.
Como o padrão disponibiliza HTTP na rede, use apenas em uma rede confiável.
Para restringir novamente à própria máquina, execute com
`NOTES_BIND_ADDRESS=127.0.0.1`. Para uso remoto, coloque o serviço atrás de
HTTPS, defina `NOTES_HTTPS=1` e não exponha diretamente a porta do container.

## Imagens Docker

### Testes

A imagem de testes instala as dependências a partir do lockfile e executa a
suíte em um ambiente limpo:

```bash
docker compose -f docker-compose.test.yml run --build --rm tests
docker compose -f docker-compose.test.yml run --build --rm permissions
```

O teste da aplicação desabilita a rede, remove capabilities, deixa o filesystem
da imagem somente para leitura e disponibiliza apenas `/tmp` em memória. Nenhum
volume persistente ou secret é usado; o SQLite temporário desaparece ao final.
O segundo teste conserva apenas as quatro capabilities do Compose de produção,
inicializa `/app/data` propositalmente como UID `12345` e confirma que as
permissões são corrigidas antes de o Next.js assumir o processo.

Também é possível executar a imagem diretamente:

```bash
docker build -f Dockerfile.test -t notes:test .
docker run --rm --network none --read-only --tmpfs /tmp notes:test
```

### Imagem local

A imagem local contém apenas a aplicação e as dependências necessárias, usa o
servidor standalone do Next.js e possui healthcheck. Um inicializador restrito
prepara as permissões do SQLite e executa a aplicação como usuário não-root.
Ela é construída pelo Compose de desenvolvimento:

```bash
docker compose -f docker.compose.dev.yml up -d --build
```

O `deploy.sh` valida os Compose de desenvolvimento e testes, executa a suíte
isolada, constrói a imagem local, atualiza o serviço e aguarda o healthcheck.
Opções:

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

Os arquivos [docker-compose.yml](docker-compose.yml) e
[docker.compose.dev.yml](docker.compose.dev.yml) aplicam filesystem somente
para leitura, capabilities limitadas à preparação inicial do SQLite, redução
de privilégios antes do Next.js, limite de processos, limite de memória,
rotação de logs e bind mount persistente em `./data`.

### Publicação de imagens

O workflow `.github/workflows/publish-image.yml` executa os testes e publica
uma nova imagem no GitHub Container Registry em todo push para a branch `main`.
Não é necessário criar uma Git tag:

```bash
git push origin main
```

Cada execução publica três referências para a mesma imagem:

- `latest`, sempre apontando para o push mais recente publicado com sucesso;
- `sha-<commit>`, identificando exatamente o commit usado no build;
- `build-<número>`, identificando a execução do GitHub Actions.

O `docker-compose.yml` usa `latest` e `pull_policy: always`, portanto
`docker compose up -d` procura a publicação mais recente.

A primeira publicação do pacote no GHCR é privada por padrão. Para permitir
instalação sem login, altere a visibilidade do pacote `safer-notes` para
**Public** nas configurações de Packages do GitHub.

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
  diretório `data` inteiro. Um backup apenas de `notes.sqlite` não contém os
  anexos.

Exemplo de backup, mantendo a aplicação parada durante a captura:

```bash
docker compose stop notes
mkdir -p backups
docker run --rm \
  --entrypoint sh \
  -v "$PWD/data:/source:ro" \
  -v "$PWD/backups:/backup" \
  ghcr.io/fbsis/safer-notes:latest \
  -c 'tar -czf "/backup/safer-notes-$(date +%Y%m%d-%H%M%S).tar.gz" -C /source .'
docker compose start notes
```

Depois da migração de um banco antigo, o SQLite pode manter páginas livres no
arquivo mesmo sem os BLOBs. Após confirmar um backup e verificar espaço livre,
esta compactação opcional devolve esse espaço:

```bash
docker compose stop notes
docker compose run --rm --no-deps notes node -e \
  "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.NOTES_DB);db.exec('VACUUM');db.close()"
docker compose start notes
```

Não há fluxo de execução ou testes diretamente no host; use sempre os comandos
Docker Compose documentados acima.

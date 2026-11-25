# Chá de casa nova — Karol e Felipe

Lista de presentes em português, feita com HTML, CSS e JavaScript puros. O catálogo fica em JSON; reservas e cancelamentos são comentários na [issue #1](https://github.com/luisfelipe998/Apartamento/issues/1). O navegador acessa diretamente a API do GitHub. Não há API própria, banco de dados ou servidor de aplicação.

Inclui oito presentes fictícios, carrossel com imagens locais ou da internet, sugestões de busca na Amazon Brasil, Mercado Livre e Shopee, ícones das lojas, filtros e busca. Tamanhos e voltagens são exemplos: ajuste antes de compartilhar.

## Testar localmente

Requer Node.js 22 ou superior. Não é necessário instalar dependências.

1. O arquivo .env local já foi preparado. Em outra máquina, copie .env.example para .env.
2. Execute npm start.
3. Abra http://localhost:3000 e entre com a senha definida em GIFT_PASSWORD no .env (o exemplo local usa **password**).

O comando gera public/access.json a partir do .env e abre uma prévia que serve somente a pasta public/. Esse servidor existe apenas para testar os arquivos estáticos; não possui rotas de API. Reservas feitas com um token configurado escrevem comentários reais na issue.

Sem GITHUB_TOKEN, a prévia entra em **modo demonstração**: reservas ficam apenas neste navegador e uma faixa informa que não são reais. A publicação por GitHub Actions exige um token e uma senha diferente de password.

Não abra index.html por file://: módulos JavaScript, fetch e Web Crypto precisam de uma origem HTTP local ou HTTPS.

## Configuração

O .env contém:

- GITHUB_TOKEN: token pessoal fine-grained, limitado ao repositório Apartamento, com **Issues: Read and write**. A permissão Metadata: Read é automática; Contents e Administration não são necessárias.
- GITHUB_OWNER: luisfelipe998.
- GITHUB_REPO: Apartamento.
- GITHUB_ISSUE_NUMBER: 1.
- GITHUB_AUTHOR: luisfelipe998, autor dos comentários que a lista reconhece.
- GIFT_PASSWORD: senha compartilhada com os convidados. O valor password serve apenas para a prévia local.
- PORT: 3000, somente para a prévia local.

O arquivo .env tem permissões locais restritas e é ignorado pelo Git. Nunca coloque o token em items.json ou no código. Depois de alterar token ou senha, execute novamente npm run build ou npm start.

npm run check:github confirma a conta e lê a issue, sem publicar comentários e sem exibir o token. Não comprova a permissão de escrita.

### Como a senha funciona em um site estático

O build cifra as credenciais em public/access.json usando AES-256-GCM e uma chave derivada da senha com PBKDF2-SHA256. No primeiro acesso, a senha abre esse arquivo e o navegador guarda uma CryptoKey PBKDF2 não exportável no IndexedDB. A senha e o token não são gravados em texto no armazenamento do navegador.

Depois de atualizar ou reabrir a página neste navegador, a chave salva abre automaticamente o arquivo de acesso atual. O token decifrado fica em memória durante o uso. O botão Sair remove a chave salva e volta a exigir a senha. Limpar os dados do site ou mudar GIFT_PASSWORD também exige um novo login. Uma nova geração do arquivo cifrado com a mesma senha mantém o acesso salvo.

**Quem conhece a senha pode extrair e usar o token.** Criptografia no navegador não impede isso. A senha de exemplo é fraca e pode ser descoberta por tentativas offline. Compartilhe apenas com convidados de confiança, use um token dedicado e substitua a senha antes da publicação. Trocar apenas a senha não revoga cópias antigas do token; revogue/substitua o token no GitHub quando precisar retirar acesso.

O catálogo JSON e as imagens continuam sendo arquivos estáticos acessíveis diretamente. A privacidade do repositório não determina a privacidade do site publicado no GitHub Pages.

## Editar os presentes

Edite public/data/items.json.

Cada recarga da página busca o JSON novamente, sem reutilizar o cache do navegador e com um parâmetro de versão na URL. Isso também acontece quando o acesso salvo abre a lista automaticamente. Na prévia local, basta salvar o arquivo e recarregar a página; no GitHub Pages, publique a versão atualizada antes de recarregar.

Cada item usa:

    {
      "id": "cafeteira",
      "name": "Café para começar o dia",
      "description": "Uma cafeteira para a nossa nova casa.",
      "category": "Cozinha",
      "images": [
        "./assets/espresso-machine.svg",
        { "src": "./assets/espresso-detail.svg", "alt": "Detalhe da cafeteira" },
        { "src": "https://images.unsplash.com/photo-1509042239860-f550ce710b93?w=800", "alt": "Foto ilustrativa de café" }
      ],
      "links": [
        { "label": "Amazon Brasil", "url": "https://www.amazon.com.br/s?k=cafeteira" },
        { "label": "Mercado Livre", "url": "https://lista.mercadolivre.com.br/cafeteira" },
        { "label": "Shopee", "url": "https://shopee.com.br/search?keyword=cafeteira" }
      ]
    }

Mantenha cada id único e estável: ele liga o produto aos comentários. Use letras, números, hífen ou sublinhado, com até 80 caracteres. Para modificar nome, descrição ou imagens, conserve o id. É possível usar várias imagens e vários links; caminhos de imagens são relativos à página, não ao arquivo JSON. O carrossel permite navegar pelas fotos com setas, teclado e gestos no celular.

Os links atuais são buscas de exemplo, não ofertas verificadas. Você pode substituí-los por páginas exatas dos produtos.

Os ícones da Amazon, Mercado Livre e Shopee são identificados pelo endereço do link e carregados de arquivos locais. Outros sites recebem um ícone genérico de loja. O campo label é opcional; se omitido, o nome da loja é usado.

### Imagens locais e da internet

Você pode misturar caminhos e URLs no mesmo images, como strings ou objetos com src e alt. Objetos com url no lugar de src também são aceitos.

- Local: coloque a imagem em public/assets/ e use ./assets/minha-foto.jpg. Não inclua public/ no caminho do JSON. JPG, PNG, WebP, SVG e outros formatos aceitos pelo navegador funcionam.
- Internet: use a URL direta de uma imagem, de preferência HTTPS. O endereço de uma página de produto não é o endereço da foto.
- Se uma imagem estiver indisponível ou o site impedir seu carregamento externo, a lista mostra a ilustração de reserva. Nesse caso, salve uma cópia autorizada em public/assets/ e use o caminho local.

Os caminhos locais são relativos à página, por isso continuam funcionando no subdiretório /Apartamento/ do GitHub Pages. Um caminho do computador, como C:\fotos\item.jpg ou file://, não estará disponível aos convidados.

## Reservas na issue

O botão Quero presentear reserva diretamente, sem formulário de nome. Cada reserva ou liberação adiciona um comentário legível e um marcador JSON apartamento-gift:v1 com action, itemId, giverName, ownerId, reservationId e timestamp. O campo giverName usa o texto genérico Convidado por compatibilidade com o formato dos comentários. Comentários comuns são ignorados, assim como eventos publicados por outros autores. Todas as páginas de comentários são consultadas.

A lista reconstrói o estado em ordem de IDs dos comentários. A primeira reserva válida de um item vence; uma liberação deve apontar para a mesma reserva e para o mesmo convidado. Após escrever, o navegador relê a issue para confirmar o resultado. A lista também atualiza a cada minuto, ao voltar à aba e pelo botão Atualizar. GitHub não oferece uma transação entre navegadores: os comentários resolvem disputas, mas uma atualização pode demorar a aparecer.

O navegador guarda um identificador local para reconhecer **Meus presentes**. Para cancelar, o convidado deve usar o mesmo navegador e manter seus dados locais. A lista não pede nem exibe nomes de presenteadores. Os comentários registram o identificador da reserva; comentários antigos podem conter os nomes informados na versão anterior. A distinção entre convidados é uma conveniência da interface, não uma barreira contra alguém que já possui o token compartilhado.

Se for necessário corrigir uma reserva manualmente, publique com a conta configurada um evento release copiando itemId, giverName, ownerId e reservationId da reserva ativa e usando um novo timestamp ISO 8601. Preserve o formato do marcador. Não altere IDs antigos do catálogo para resolver uma reserva.

## Publicar no GitHub Pages

O código está preparado para publicação; nenhuma publicação é feita por npm start.

1. Envie o código para o repositório, mantendo .env e public/access.json fora do Git.
2. Em Settings → Secrets and variables → Actions, crie GIFT_GITHUB_TOKEN com o token dedicado e GIFT_PASSWORD com a senha escolhida.
3. Em Settings → Pages → Build and deployment, selecione GitHub Actions.
4. Em Actions, execute manualmente **Publicar lista de presentes**.

O workflow testa o código, exige os dois secrets, rejeita a senha de exemplo password, gera o arquivo cifrado e publica **somente public/**. Não use o GITHUB_TOKEN automático de Actions como token dos convidados: ele expira ao terminar o job. O fluxo é manual para você decidir quando publicar mudanças na lista.

Para atualizar os presentes, faça commit e push do JSON e execute novamente o workflow. Para trocar a senha, atualize o secret GIFT_PASSWORD e execute o workflow; mudar apenas o .env afeta somente a prévia local.

O endereço esperado é https://luisfelipe998.github.io/Apartamento/. Os caminhos relativos suportam esse subdiretório. Um repositório privado exige um plano do GitHub compatível com Pages; controle privado de acesso ao próprio site é um recurso separado. Se Pages estiver desabilitado para o plano atual, o mesmo public/ pode ser hospedado em qualquer serviço de arquivos estáticos com HTTPS.

## Verificações

- npm test: criptografia, senha inválida, proteção do .env na prévia, paginação, eventos inválidos, conflito entre convidados, cancelamento e falhas do GitHub. Usa credenciais e comentários fictícios.
- npm run test:browser: fluxo visual no Chrome, com uma cópia temporária, token fictício e respostas do GitHub simuladas. Testa o fetch nativo do navegador sem enviar requisições à issue real. Requer Chrome instalado; CHROME_BIN permite indicar outro Chromium.
- npm run check:github: verificação real, somente de leitura, usando o .env.

Nenhuma dependência de runtime, framework ou serviço adicional é necessária no GitHub Pages.

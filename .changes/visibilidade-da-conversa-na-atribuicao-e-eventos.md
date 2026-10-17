---
impacto: nada_mudou
secao: corrigido
titulo: A visibilidade de cada conversa vale também na atribuição e no registro de eventos
---

Assumir ou transferir uma conversa que o atendente não enxerga agora responde como uma conversa que não existe. No registro interno de eventos, o evento ligado a uma conversa passa a seguir a mesma regra de quem pode ver a conversa (o modo de visibilidade em Configurações › Atendimento); a conversa do evento é resolvida pelo entity_id (conversation/conversation_note), por payload.conversation_id, ou pelo ref_id do aviso da Central. Quem só lê (viewer), gestores, administradores e o administrador da plataforma continuam vendo todos. Para o atendente, um valor sem forma de identificador de conversa não restringe nada (o evento segue o pertencimento à organização, como antes), e um identificador que não aponta para uma conversa da organização fica oculto. A atualização aplica a mudança de banco sozinha; nada a fazer.

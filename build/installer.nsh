; Muxlyve — instalador personalizado

; Default to English if system language isn't matched
; Since en_US is listed first in package.json, it should be the fallback.

!pragma warning push
!pragma warning disable 6030

LangString WELCOME_TITLE 1033 "Welcome to Muxlyve"
LangString WELCOME_TITLE 3082 "Bienvenido a Muxlyve"
LangString WELCOME_TITLE 1036 "Bienvenue dans Muxlyve"
LangString WELCOME_TITLE 1046 "Bem-vindo ao Muxlyve"

LangString WELCOME_TEXT 1033 "This wizard will install Muxlyve on your computer.$\r$\n$\r$\nMuxlyve allows you to stream simultaneously to Twitch, Kick, YouTube and TikTok from your own PC — without a watermark and without paying monthly fees.$\r$\n$\r$\nClick Next to continue."
LangString WELCOME_TEXT 3082 "Este asistente instalará Muxlyve en tu equipo.$\r$\n$\r$\nMuxlyve te permite transmitir en simultáneo a Twitch, Kick, YouTube y TikTok desde tu propia PC — sin marca de agua y sin pagar mensualidades.$\r$\n$\r$\nHaz clic en Siguiente para continuar."
LangString WELCOME_TEXT 1036 "Cet assistant va installer Muxlyve sur ton ordinateur.$\r$\n$\r$\nMuxlyve te permet de streamer en simultané sur Twitch, Kick, YouTube et TikTok depuis ton propre PC — sans filigrane et sans abonnement mensuel.$\r$\n$\r$\nClique sur Suivant pour continuer."
LangString WELCOME_TEXT 1046 "Este assistente vai instalar o Muxlyve no seu computador.$\r$\n$\r$\nO Muxlyve permite transmitir simultaneamente para Twitch, Kick, YouTube e TikTok direto do seu PC — sem marca d'água e sem mensalidades.$\r$\n$\r$\nClique em Avançar para continuar."

LangString FINISH_TITLE 1033 "Muxlyve installed!"
LangString FINISH_TITLE 3082 "¡Muxlyve instalado!"
LangString FINISH_TITLE 1036 "Muxlyve est installé !"
LangString FINISH_TITLE 1046 "Muxlyve instalado!"

LangString FINISH_TEXT 1033 "Muxlyve has been installed successfully on your computer.$\r$\n$\r$\nClick Finish to close this wizard."
LangString FINISH_TEXT 3082 "Muxlyve se instaló correctamente en tu equipo.$\r$\n$\r$\nHaz clic en Finalizar para cerrar este asistente."
LangString FINISH_TEXT 1036 "Muxlyve a été installé avec succès sur ton ordinateur.$\r$\n$\r$\nClique sur Terminer pour fermer cet assistant."
LangString FINISH_TEXT 1046 "O Muxlyve foi instalado com sucesso no seu computador.$\r$\n$\r$\nClique em Concluir para fechar este assistente."

LangString FINISH_RUN_TEXT 1033 "Open Muxlyve"
LangString FINISH_RUN_TEXT 3082 "Abrir Muxlyve"
LangString FINISH_RUN_TEXT 1036 "Ouvrir Muxlyve"
LangString FINISH_RUN_TEXT 1046 "Abrir o Muxlyve"

!pragma warning pop

!define MUI_WELCOMEPAGE_TITLE $(WELCOME_TITLE)
!define MUI_WELCOMEPAGE_TEXT $(WELCOME_TEXT)

!define MUI_FINISHPAGE_TITLE $(FINISH_TITLE)
!define MUI_FINISHPAGE_TEXT $(FINISH_TEXT)
!define MUI_FINISHPAGE_RUN_TEXT $(FINISH_RUN_TEXT)

; Header image — aparece en páginas de progreso / componentes
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "${PROJECT_DIR}\build\installer-header.bmp"
!define MUI_HEADERIMAGE_RIGHT

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customInit
  SetRegView 64
!macroend

!macro customInstall
!macroend

!macro customUnInstall
!macroend

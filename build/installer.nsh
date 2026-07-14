; Muxlyve — instalador personalizado

!define MUI_WELCOMEPAGE_TITLE "Bienvenido a Muxlyve"
!define MUI_WELCOMEPAGE_TEXT "Este asistente instalará Muxlyve en tu equipo.$\r$\n$\r$\nMuxlyve te permite transmitir en simultáneo a Twitch, Kick, YouTube y TikTok desde tu propia PC — sin marca de agua y sin pagar mensualidades.$\r$\n$\r$\nHaz clic en Siguiente para continuar."

!define MUI_FINISHPAGE_TITLE "¡Muxlyve instalado!"
!define MUI_FINISHPAGE_TEXT "Muxlyve se instaló correctamente en tu equipo.$\r$\n$\r$\nHaz clic en Finalizar para cerrar este asistente."
!define MUI_FINISHPAGE_RUN_TEXT "Abrir Muxlyve"

!define MUI_WELCOMEFINISHPAGE_BITMAP "${PROJECT_DIR}\build\installer-sidebar.bmp"

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

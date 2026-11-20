import frappe
from frappe import _
from frappe.model.document import Document

# Cobro: la retención la hace el cliente a la empresa -> cuenta de activo acreditable.
# Pago: la retención la hace la empresa al proveedor -> cuenta de pasivo por enterar.
ROOT_POR_OPERACION = {"Cobro": "Asset", "Pago": "Liability"}
NATURALEZA = {
	"Asset": "activo",
	"Liability": "pasivo",
	"Equity": "patrimonio",
	"Income": "ingreso",
	"Expense": "gasto",
}


class DSCRetencionConfig(Document):
	def validate(self):
		activas = set()
		for r in self.reglas:
			fila = _("Fila {0}").format(r.idx)

			if not 0 < (r.tasa or 0) <= 100:
				frappe.throw(_("{0}: la tasa debe ser mayor que 0 y no pasar de 100.").format(fila))

			if (r.monto_minimo or 0) < 0:
				frappe.throw(_("{0}: el monto mínimo no puede ser negativo (use 0 para no tener límite).").format(fila))

			if not r.base_calculo:
				r.base_calculo = "Subtotal sin IVA"

			if r.activo:
				clave = (r.operacion, r.concepto)
				if clave in activas:
					frappe.throw(
						_("{0}: ya existe una regla activa de {1} para {2}. Desactive una de las dos.").format(
							fila, r.concepto, r.operacion
						)
					)
				activas.add(clave)

			self.validar_cuenta(r, fila)

	def validar_cuenta(self, r, fila):
		cuenta = frappe.db.get_value(
			"Account",
			r.cuenta,
			["company", "is_group", "disabled", "root_type"],
			as_dict=True,
		)
		if not cuenta:
			frappe.throw(_("{0}: la cuenta {1} no existe.").format(fila, r.cuenta))
		if cuenta.company != self.company:
			frappe.throw(_("{0}: la cuenta {1} no pertenece a la empresa {2}.").format(fila, r.cuenta, self.company))
		if cuenta.is_group:
			frappe.throw(_("{0}: la cuenta {1} es un grupo; elija una cuenta de movimiento.").format(fila, r.cuenta))
		if cuenta.disabled:
			frappe.throw(_("{0}: la cuenta {1} está deshabilitada.").format(fila, r.cuenta))

		esperado = ROOT_POR_OPERACION.get(r.operacion)
		if esperado and cuenta.root_type != esperado:
			frappe.throw(
				_("{0}: en una operación de {1} la cuenta debe ser de {2}, pero {3} es de tipo {4}.").format(
					fila,
					r.operacion,
					NATURALEZA[esperado],
					r.cuenta,
					NATURALEZA.get(cuenta.root_type, cuenta.root_type),
				)
			)
